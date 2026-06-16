import * as vscode from "vscode";
import {
  OpenCodeRequestError,
} from "./errors";
import {
  MODEL_METADATA_CACHE_KEY,
  MODEL_METADATA_REVISION,
  MODELS_DEV_API_URL,
  bundledModelMetadataSnapshot,
  fallbackModelMetadata,
  getContextSizeOptions,
  hasExplicitModelLimits,
  isFreshModelMetadata,
  normalizeLiveModelMetadata,
  normalizeModelsDevSnapshot,
  resolveModelMetadata,
  toEffectiveModelId,
  type BaseModelLimits,
  type CachedModelMetadataSnapshot,
  type ContextSizeOption,
  type ModelCost,
  type ModelMetadataFields,
  type ModelsDevResponse,
  type ResolvedModelMetadata,
} from "./metadata";
import {
  resolveModelRouting,
} from "./routing";
import {
  buildFamilyThinkingSchema,
  buildQwenAnthropicThinkingPayload,
  buildThinkingPayload,
  applyRequestThinkingOverride,
  thinkingFamily,
  type ThinkingFamily,
  type ThinkingSettings,
} from "./thinking";
import { buildOpenCodeGatewayAuthHeaders } from "./openCodeAuth";
import {
  streamAnthropicMessages as runStreamAnthropicMessages,
  streamChatCompletions as runStreamChatCompletions,
  streamGoogleGenerateContent as runStreamGoogleGenerateContent,
  streamResponsesApi as runStreamResponsesApi,
  type TransportRequestSummary,
} from "./streaming";
import { GO_VENDOR, ZEN_VENDOR, AGENT_GO_VENDOR, AGENT_ZEN_VENDOR, resolveBaseVendor, type AllProviderVendor, type ProviderVendor } from "./providerTypes";
import { isInternalDataPart } from "./chatParts";
import { PersistentAutocompleteProvider } from "./autocomplete";

import {
  formatCacheHitRatio,
  formatUsageStatusBarText,
  formatUsageStatusBarTooltip,
  type UsageSnapshot,
} from "./usage";
import {
  GoUsageTracker,
  formatGoUsageStatusBarText,
} from "./goUsageTracker";

const SECRET_KEY = "opencodego.apiKey";
const RECENT_TRANSPORT_SUMMARY_LIMIT = 25;
const RECENT_TRANSPORT_SUMMARY_STORAGE_PREFIX = "opencode.recentTransportSummaries";

let usageStatusBarItem: vscode.StatusBarItem | undefined;
let goUsageStatusBarItem: vscode.StatusBarItem | undefined;

/** Maps base vendor → agent-variant provider instance for cross-resolution. */
const agentProvidersByBaseVendor = new Map<string, OpenCodeProvider>();

let goUsageTracker: GoUsageTracker | undefined;
let usageWebviewPanel: vscode.WebviewPanel | undefined;

interface ProviderDefinition {
  vendor: AllProviderVendor;
  displayName: string;
  modelNamePrefix: string;
  modelsUrl: string;
  chatCompletionsUrl: string;
  messagesUrl: string;
  responsesUrl?: string;
  categoryOrder: number;
  testModelId: string;
  fallbackModels: string[];
  filterModel?: (modelId: string) => boolean;
  /** When true, this provider only serves agent-host models (targetChatSessionType=copilotcli). */
  isAgentVariant?: boolean;
  /** The vendor key for the main (non-agent) provider definition this variant mirrors. */
  baseVendor?: typeof GO_VENDOR | typeof ZEN_VENDOR;
}

type ModelEndpointKind =
  | "chat-completions"
  | "messages"
  | "responses"
  | "google";

const FREE_ZEN_MODEL_IDS = new Set(["big-pickle"]);
const KNOWN_UNAVAILABLE_MODEL_IDS = new Set([
  "ring-2.6-1t",
  "ring-2.6-1t-free",
  "trinity-large-preview-free"
]);
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const OPEN_CODE_CLIENT = "vscode-copilot-chat";
const OPEN_CODE_USER_AGENT = "opencode-copilot-chat/0.3.2 VSCode";

/** Create an agent-variant provider definition that inherits URLs, models, and filters from a base. */
function providerVariant(
  base: ProviderDefinition,
  agentVendor: typeof AGENT_GO_VENDOR | typeof AGENT_ZEN_VENDOR,
  displayName: string,
  categoryOrder: number,
): ProviderDefinition {
  return {
    vendor: agentVendor,
    displayName,
    modelNamePrefix: base.modelNamePrefix,
    modelsUrl: base.modelsUrl,
    chatCompletionsUrl: base.chatCompletionsUrl,
    messagesUrl: base.messagesUrl,
    responsesUrl: base.responsesUrl,
    categoryOrder,
    testModelId: base.testModelId,
    fallbackModels: base.fallbackModels,
    filterModel: base.filterModel,
  };
}

const PROVIDERS: Record<ProviderDefinition["vendor"], ProviderDefinition> = (() => {
  const go: ProviderDefinition = {
    vendor: GO_VENDOR,
    displayName: "OpenCode Go",
    modelNamePrefix: "OpenCode Go",
    modelsUrl: "https://opencode.ai/zen/go/v1/models",
    chatCompletionsUrl: "https://opencode.ai/zen/go/v1/chat/completions",
    messagesUrl: "https://opencode.ai/zen/go/v1/messages",
    categoryOrder: 2,
    testModelId: "deepseek-v4-flash",
    fallbackModels: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "glm-5.1",
      "glm-5",
      "hy3-preview",
      "kimi-k2.6",
      "kimi-k2.5",
      "mimo-v2-omni",
      "mimo-v2-pro",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "minimax-m2.7",
      "minimax-m2.5",
      "qwen3.7-max",
      "qwen3.6-plus",
      "qwen3.5-plus",
    ]
  };
  const zen: ProviderDefinition = {
    vendor: ZEN_VENDOR,
    displayName: "OpenCode Zen",
    modelNamePrefix: "OpenCode Zen",
    modelsUrl: "https://opencode.ai/zen/v1/models",
    chatCompletionsUrl: "https://opencode.ai/zen/v1/chat/completions",
    messagesUrl: "https://opencode.ai/zen/v1/messages",
    responsesUrl: "https://opencode.ai/zen/v1/responses",
    categoryOrder: 3,
    testModelId: "deepseek-v4-flash-free",
    fallbackModels: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-opus-4-1",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-sonnet-4",
      "claude-haiku-4-5",
      "deepseek-v4-flash-free",
      "gemini-3.5-flash",
      "gemini-3.1-pro",
      "gemini-3-flash",
      "glm-5.1",
      "glm-5",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-pro",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.1",
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
      "gpt-5",
      "gpt-5-codex",
      "gpt-5-nano",
      "grok-build-0.1",
      "kimi-k2.6",
      "kimi-k2.5",
      "minimax-m2.7",
      "minimax-m2.5",
      "minimax-m2.5-free",
      "nemotron-3-super-free",
      "qwen3.6-plus",
      "qwen3.6-plus-free",
      "qwen3.5-plus",
      "big-pickle"
    ],
    filterModel: (modelId) => vscode.workspace.getConfiguration("opencodego").get("freeOnly", true) ? modelId.endsWith("-free") || FREE_ZEN_MODEL_IDS.has(modelId) : true
  };
  return {
    [GO_VENDOR]: go,
    [ZEN_VENDOR]: zen,
    [AGENT_GO_VENDOR]: { ...providerVariant(go, AGENT_GO_VENDOR, "OpenCode Go (Agents)", 4), isAgentVariant: true, baseVendor: GO_VENDOR },
    [AGENT_ZEN_VENDOR]: { ...providerVariant(zen, AGENT_ZEN_VENDOR, "OpenCode Zen (Agents)", 5), isAgentVariant: true, baseVendor: ZEN_VENDOR },
  };
})();

type ApiRole = "user" | "assistant" | "tool";

interface OpenCodeModel extends vscode.LanguageModelChatInformation {
  endpointKind: ModelEndpointKind;
  provider: ProviderDefinition;
  rawModelId?: string;
  category?: {
    label: string;
    order: number;
  };
  isUserSelectable?: boolean;
  configurationSchema?: vscode.LanguageModelConfigurationSchema;
}

interface ModelListEntry {
  id?: string;
  owned_by?: string;
  status?: string;
  deprecated?: boolean;
  limit?: {
    context?: number;
    output?: number;
  };
  context_window?: number;
  contextWindow?: number;
  max_output_tokens?: number;
  maxOutputTokens?: number;
  attachment?: boolean;
  image_input?: boolean;
  imageInput?: boolean;
  reasoning?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
}

interface ModelListResponse {
  data?: ModelListEntry[];
}

interface ApiMessage {
  role: ApiRole;
  content: string | null | OpenAiContentPart[];
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

interface OpenAiContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
  };
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Reasoning effort levels per model family, sourced from the upstream
 * OpenCode provider transform (anomalyco/opencode, packages/opencode/src/provider/transform.ts):
 *
 *   WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
 *   OPENAI_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"]
 *
 * For @ai-sdk/openai-compatible (Mimo, and most models routed through
 * chat-completions): the default is WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"].
 * DeepSeek V4 on openai-compatible additionally adds "max" → ["low", "medium", "high", "max"].
 */
interface ApiSettings {
  temperature: number;
  maxOutputTokensOverride: number;
  maxInputTokensOverride: number;
  debugReasoning: boolean;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  thinking: ThinkingSettings;
  stripThinkTags: "never" | "auto" | "always";
}

interface LanguageModelConfiguration {
  apiKey?: unknown;
}

type ConfiguredLanguageModelInfoOptions = vscode.PrepareLanguageModelChatModelOptions & {
  configuration?: LanguageModelConfiguration;
};

type ConfiguredLanguageModelResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  configuration?: LanguageModelConfiguration;
};

interface ModelLimits extends BaseModelLimits {
  advertisedContextWindow: number;
  advertisedMaxInputTokens: number;
  advertisedMaxOutputTokens: number;
}

interface ModelRoutingFields {
  endpointKind: ModelEndpointKind;
  endpointUrl: string;
  sdkPackage?: string;
}

// Copilot surfaces combine input/output metadata differently across views.
// Reserve a modest UI output budget, while requests still use the real model max.
const UI_OUTPUT_TOKEN_RESERVE = 8192;
const MESSAGE_TOKEN_OVERHEAD = 4;
const MESSAGE_NAME_TOKEN_OVERHEAD = 1;
const TOOL_CALL_TOKEN_OVERHEAD = 10;
const TOOL_RESULT_TOKEN_OVERHEAD = 6;
const IMAGE_TOKEN_ESTIMATE = 1024;

type CopilotCompatibleCapabilities = vscode.LanguageModelChatCapabilities & {
  supportsToolCalling: boolean;
  supportsImageToText: boolean;
};

// Models live on the OpenCode Zen gateway but with constrained GPU capacity.
// They were re-enabled by the OpenCode team after a brief shutdown
// ("Qwen 3.6 Plus — free, again. Round 2. We found more GPUs.") so they are
// NOT deprecated, but agentic workloads with long histories or large tool
// catalogs can still hit 5xx during traffic bursts. Surface this so users know
// to retry or fall back to another free model if the request fails.
const CAPACITY_LIMITED_MODEL_NOTES: Record<string, string> = {
  "qwen3.6-plus-free": "Free relaunch with limited GPU capacity. Stable for short prompts; bursty traffic or very large tool catalogs may return 5xx - retry or fall back to 'deepseek-v4-flash-free' / 'big-pickle'. Paid 'qwen3.6-plus' has no quota."
};

let modelMetadataSnapshot: CachedModelMetadataSnapshot | undefined;
let modelMetadataRefreshPromise: Promise<CachedModelMetadataSnapshot> | undefined;

interface OpenAiToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: object;
}

interface AnthropicCacheControl {
  type: "ephemeral";
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

interface AnthropicImageSourceUrl {
  type: "url";
  url: string;
}

interface AnthropicImageSourceBase64 {
  type: "base64";
  media_type: string;
  data: string;
}

type AnthropicImageSource = AnthropicImageSourceUrl | AnthropicImageSourceBase64;

interface AnthropicImageBlock {
  type: "image";
  source: AnthropicImageSource;
  cache_control?: AnthropicCacheControl;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  cache_control?: AnthropicCacheControl;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  cache_control?: AnthropicCacheControl;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicRequestMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

interface RecentTransportSummary extends TransportRequestSummary {
  recordedAt: string;
  endpointKind: string;
  metadataSource: string;
  requestInitiator?: string;
}

export function activate(context: vscode.ExtensionContext) {
  const goUsageLogChannel = vscode.window.createOutputChannel("OpenCode Go Usage");
  context.subscriptions.push(goUsageLogChannel);
  goUsageTracker = new GoUsageTracker(context, (msg) => {
    goUsageLogChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  });
  ensureUsageStatusBar(context);
  ensureGoUsageStatusBar(context);
  const goProvider = new OpenCodeProvider(context, PROVIDERS[GO_VENDOR]);
  const zenProvider = new OpenCodeProvider(context, PROVIDERS[ZEN_VENDOR]);

  const subscriptions: vscode.Disposable[] = [
    vscode.lm.registerLanguageModelChatProvider(GO_VENDOR, goProvider),
    vscode.lm.registerLanguageModelChatProvider(ZEN_VENDOR, zenProvider),
    vscode.commands.registerCommand("opencodego.manage", () => goProvider.manage()),
    vscode.commands.registerCommand("opencodego.diagnostics", () => goProvider.showDiagnostics()),
    vscode.commands.registerCommand("opencodego.setApiKey", () => goProvider.setApiKey()),
    vscode.commands.registerCommand("opencodezen.diagnostics", () => zenProvider.showDiagnostics()),
    vscode.commands.registerCommand("opencodego.modelPickerDiagnostics", () => showModelPickerDiagnostics()),
    vscode.commands.registerCommand("opencodego.setThinkingEffort", () => showThinkingEffortPicker()),
    vscode.commands.registerCommand("opencodego.showUsageDetails", () => showUsageWebview(context)),
  ];

  // ─── Persistent Autocomplete Provider ────────────────────────────────────
  const autocompleteOutput = vscode.window.createOutputChannel("OpenCode Autocomplete");
  context.subscriptions.push(autocompleteOutput);
  const autocompleteProvider = new PersistentAutocompleteProvider(context, autocompleteOutput);
  context.subscriptions.push(autocompleteProvider);

  // Register for ALL files — provider filters by language internally
  const autocompleteRegistration = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" },
    autocompleteProvider,
  );
  context.subscriptions.push(autocompleteRegistration);
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodego.autocompleteAccepted", (args) => {
      autocompleteOutput.appendLine(
        `[accepted] sessionId=${args?.sessionId ?? "unknown"} model=${args?.model ?? "unknown"} length=${args?.length ?? "unknown"}`,
      );
    }),
  );

  // Agent-host providers for the Copilot Agents window (opt-in via config).
  const enableAgents = vscode.workspace.getConfiguration("opencodego").get<boolean>("agentsWindow", true);
  if (enableAgents) {
    const agentGoProvider = new OpenCodeProvider(context, PROVIDERS[AGENT_GO_VENDOR]);
    const agentZenProvider = new OpenCodeProvider(context, PROVIDERS[AGENT_ZEN_VENDOR]);
    agentProvidersByBaseVendor.set(GO_VENDOR, agentGoProvider);
    agentProvidersByBaseVendor.set(ZEN_VENDOR, agentZenProvider);
    subscriptions.push(
      vscode.lm.registerLanguageModelChatProvider(AGENT_GO_VENDOR, agentGoProvider),
      vscode.lm.registerLanguageModelChatProvider(AGENT_ZEN_VENDOR, agentZenProvider),
    );
  }

  context.subscriptions.push(...subscriptions);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("opencodego.showUsageStatusBar")) {
        resetUsageStatusBar();
      }
    }),
  );

  void warmModelPickerMetadata();
}

async function warmModelPickerMetadata(): Promise<void> {
  const vendors: string[] = [GO_VENDOR, ZEN_VENDOR];
  if (vscode.workspace.getConfiguration("opencodego").get<boolean>("agentsWindow", true)) {
    vendors.push(AGENT_GO_VENDOR, AGENT_ZEN_VENDOR);
  }
  await Promise.allSettled(vendors.map(v => vscode.lm.selectChatModels({ vendor: v })));
}

async function showModelPickerDiagnostics(): Promise<void> {
  const vendors: string[] = [GO_VENDOR, ZEN_VENDOR, "copilot"];
  if (vscode.workspace.getConfiguration("opencodego").get<boolean>("agentsWindow", true)) {
    vendors.splice(2, 0, AGENT_GO_VENDOR, AGENT_ZEN_VENDOR);
  }
  const sections: string[] = [];

  for (const vendor of vendors) {
    const models = await vscode.lm.selectChatModels({ vendor });
    sections.push(`## vendor: ${vendor}`, "", `models: ${models.length}`, "");
    for (const model of models) {
      const internalModel = model as unknown as { configurationSchema?: unknown; detail?: unknown };
      const schema = internalModel.configurationSchema;
      sections.push(
        `### ${model.name}`,
        "",
        `- id: \`${model.id}\``,
        `- family: \`${model.family}\``,
        `- version: \`${model.version}\``,
        `- vendor: \`${model.vendor}\``,
        `- detail: \`${typeof internalModel.detail === "string" ? internalModel.detail : ""}\``,
        `- schema:`,
        "```json",
        JSON.stringify(schema ?? null, null, 2),
        "```",
        ""
      );
    }
  }

  const doc = await vscode.workspace.openTextDocument({
    content: ["# OpenCode Model Picker Diagnostics", "", ...sections].join("\n"),
    language: "markdown"
  });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

async function showThinkingEffortPicker(): Promise<void> {
  const families: { label: string; key: keyof ThinkingSettings; options: string[] }[] = [
    { label: "DeepSeek (deepseek-v4-*)", key: "deepseek", options: ["off", "low", "medium", "high", "max"] },
    { label: "GLM (glm-5, glm-5.1)", key: "glm", options: ["on", "off"] },
    { label: "Kimi (kimi-k2.*)", key: "kimi", options: ["on", "off"] },
    { label: "Mimo (mimo-v2.*)", key: "mimo", options: ["off", "low", "medium", "high"] },
    { label: "MiniMax (minimax-m*)", key: "minimax", options: ["off", "on"] },
    { label: "Qwen (qwen3.*)", key: "qwen", options: ["auto", "on", "off"] },
    { label: "Qwen Thinking Budget", key: "qwenBudget", options: ["auto", "4096", "16384", "32768", "81920"] }
  ];
  const settings = getSettings().thinking;
  const family = await vscode.window.showQuickPick(
    families.map(f => ({ label: f.label, description: `current: ${settings[f.key]}`, family: f })),
    { placeHolder: "Pick a model family to configure Thinking" }
  );
  if (!family) return;
  const choice = await vscode.window.showQuickPick(family.family.options, {
    placeHolder: `Set ${family.family.label} → Thinking value`
  });
  if (!choice) return;
  const cfg = vscode.workspace.getConfiguration("opencodego.thinking");
  await cfg.update(family.family.key, choice, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`OpenCode Thinking — ${family.family.label}: ${choice}`);
}

export async function deactivate(): Promise<void> {
  // no-op: experimental context indicator hooks removed in 0.1.8
}

function ensureUsageStatusBar(
  context: vscode.ExtensionContext,
): vscode.StatusBarItem {
  if (!usageStatusBarItem) {
    usageStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      95,
    );
    context.subscriptions.push(usageStatusBarItem);
  }

  resetUsageStatusBar();
  return usageStatusBarItem;
}

function shouldShowUsageStatusBar(): boolean {
  return vscode.workspace
    .getConfiguration("opencodego")
    .get("showUsageStatusBar", true);
}

function resetUsageStatusBar(): void {
  if (!usageStatusBarItem) {
    return;
  }

  if (!shouldShowUsageStatusBar()) {
    usageStatusBarItem.hide();
    return;
  }

  usageStatusBarItem.text = "OpenCode";
  usageStatusBarItem.tooltip = "OpenCode usage summary";
  usageStatusBarItem.show();
}

function updateUsageStatusBar(
  providerDisplayName: string,
  modelId: string,
  summary: TransportRequestSummary,
): void {
  if (!usageStatusBarItem) {
    return;
  }

  if (!shouldShowUsageStatusBar()) {
    usageStatusBarItem.hide();
    return;
  }

  const usage: UsageSnapshot = {
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    totalTokens: summary.totalTokens,
    cachedTokens: summary.cachedTokens,
    finishReason: summary.finishReason,
  };
  const text = formatUsageStatusBarText(providerDisplayName, usage);

  usageStatusBarItem.text = text ?? providerDisplayName;
  usageStatusBarItem.tooltip = formatUsageStatusBarTooltip(
    providerDisplayName,
    modelId,
    usage,
  );
  usageStatusBarItem.show();
}


function ensureGoUsageStatusBar(context: vscode.ExtensionContext): void {
  if (goUsageStatusBarItem) return;
  goUsageStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    94,
  );
  goUsageStatusBarItem.command = "opencodego.showUsageDetails";
  context.subscriptions.push(goUsageStatusBarItem);
  refreshGoUsageStatusBar();
}



function refreshGoUsageStatusBar(): void {
  if (!goUsageStatusBarItem || !goUsageTracker) return;
  const s = goUsageTracker.getSummary();
  goUsageStatusBarItem.text    = formatGoUsageStatusBarText(s);
  goUsageStatusBarItem.tooltip = buildUsageTooltip(s);
  goUsageStatusBarItem.show();
  updateWebviewContent();
}

function showUsageWebview(context: vscode.ExtensionContext): void {
  if (usageWebviewPanel) {
    usageWebviewPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  usageWebviewPanel = vscode.window.createWebviewPanel(
    "opencodego.usageWebview",
    "OpenCode Usage Summary",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  usageWebviewPanel.onDidDispose(() => {
    usageWebviewPanel = undefined;
  }, null, context.subscriptions);

  updateWebviewContent();
}

function updateWebviewContent(): void {
  if (!usageWebviewPanel || !goUsageTracker) return;
  const s = goUsageTracker.getSummary();
  const svg = buildUsageTooltipSvg(s);

  usageWebviewPanel.webview.html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>OpenCode Usage Summary</title>
      <style>
        body {
          display: flex;
          justify-content: center;
          align-items: flex-start;
          height: 100vh;
          background-color: var(--vscode-editor-background);
          color: var(--vscode-editor-foreground);
          margin: 0;
          padding: 20px;
          box-sizing: border-box;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .container {
          width: 100%;
          max-width: 480px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 15px;
        }
        svg {
          width: 100%;
          height: auto;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
          background-color: #1e1e1e;
        }
      </style>
    </head>
    <body>
      <div class="container">
        ${svg}
      </div>
    </body>
    </html>
  `;
}

function buildUsageTooltip(s: ReturnType<GoUsageTracker["getSummary"]>): vscode.MarkdownString {
  const md = new vscode.MarkdownString("", true);
  md.supportHtml = true;
  md.appendMarkdown(
    `<img alt="OpenCode Go usage summary" src="${usageTooltipSvgDataUri(s)}" width="330">`,
  );

  return md;
}

type _UsageSummary = ReturnType<GoUsageTracker["getSummary"]>;

function usageTooltipSvgDataUri(s: _UsageSummary): string {
  const svg = buildUsageTooltipSvg(s);
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function buildUsageTooltipSvg(s: _UsageSummary): string {
  const width = 330;
  const height = s.hasData ? 286 : 78;
  const bg = "#1e1e1e";
  const fg = "#d4d4d4";
  const muted = "#a6a6a6";
  const track = "#3c3c3c";
  const accent = "#73c991";
  const line = "#333333";
  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const text = (
    value: string,
    x: number,
    y: number,
    size: number,
    weight = 400,
    color = fg,
    anchor: "start" | "end" = "start",
  ): string =>
    `<text x="${x}" y="${y}" fill="${color}" font-family="${font}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escapeSvg(value)}</text>`;

  const bar = (pct: number, x: number, y: number, barWidth: number): string => {
    const clamped = Math.min(Math.max(pct, 0), 100);
    const fillWidth = Math.max(0, Math.round((clamped / 100) * barWidth));
    return [
      `<rect x="${x}" y="${y}" width="${barWidth}" height="5" rx="2.5" fill="${track}"/>`,
      fillWidth > 0
        ? `<rect x="${x}" y="${y}" width="${fillWidth}" height="5" rx="2.5" fill="${accent}"/>`
        : "",
    ].join("");
  };

  const period = (
    label: string,
    p: _UsageSummary["session"],
    y: number,
  ): string => [
    text(label, 14, y, 14, 700),
    text(`Resets in ${rel(p.resetsAt)}`, 306, y, 12, 400, muted, "end"),
    bar(p.percent, 14, y + 12, 256),
    text(`${p.percent.toFixed(1)}%`, 306, y + 19, 14, 700, fg, "end"),
    text(`${usd(p.spent)} / ${usd(p.limit)} used`, 14, y + 34, 13, 400, fg),
  ].join("");

  if (!s.hasData) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" rx="4" fill="${bg}"/>
${text("OpenCode Go - Usage", 14, 26, 16, 700)}
${text("No usage data yet. Send a chat message to start tracking.", 14, 50, 12, 400, muted)}
</svg>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" rx="4" fill="${bg}"/>
${text("OpenCode Go - Usage", 14, 26, 16, 700)}
${period("Session (5h rolling)", s.session, 54)}
${period("Weekly", s.weekly, 116)}
${period("Monthly", s.monthly, 178)}
<line x1="14" y1="224" x2="316" y2="224" stroke="${line}" stroke-width="1"/>
${text("Today:", 14, 256, 13, 400, muted)}
${text(usd(s.today.cost), 58, 256, 13, 700)}
${text("Requests:", 138, 256, 13, 400, muted)}
${text(String(s.today.requests), 202, 256, 13, 700)}
${text("Tokens:", 236, 256, 13, 400, muted)}
${text(tokens(s.today.tokens), 296, 256, 13, 700)}
${s.yesterday.requests > 0 ? [
    text("Yesterday:", 14, 278, 13, 400, muted),
    text(usd(s.yesterday.cost), 80, 278, 13, 700),
    text("Requests:", 154, 278, 13, 400, muted),
    text(String(s.yesterday.requests), 218, 278, 13, 700),
  ].join("") : ""}
</svg>`;
}

function escapeSvg(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function usd(v: number): string { return `$${v.toFixed(2)}`; }
function tokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
  return v.toString();
}
function rel(date: Date): string {
  const min = Math.max(0, Math.floor((date.getTime() - Date.now()) / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

class OpenCodeProvider implements vscode.LanguageModelChatProvider<OpenCodeModel> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
  private readonly apiKeysByModelId = new Map<string, string>();
  private readonly reasoningContentByToolCallId = new Map<string, string>();
  private readonly liveModelMetadataById = new Map<string, ModelMetadataFields>();
  private readonly recentTransportSummaries: RecentTransportSummary[] = [];
  private outputChannel: vscode.OutputChannel | undefined;

  /** Allow the main provider to trigger re-resolution on the agent variant after BYOK key is stored. */
  triggerChange(): void {
    this.changeEmitter.fire();
  }

  /** Resolves agent-host variants to their base vendor for metadata/routing. */
  private get baseVendor(): ProviderVendor {
    return resolveBaseVendor(this.definition.vendor);
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly definition: ProviderDefinition
  ) {
    this.restoreRecentTransportSummaries();
  }

  private getOutputChannel(): vscode.OutputChannel {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel("OpenCode");
      this.context.subscriptions.push(this.outputChannel);
    }
    return this.outputChannel;
  }

  private log(message: string): void {
    this.getOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private async getMetadataSnapshot(): Promise<CachedModelMetadataSnapshot> {
    return getOpenCodeModelMetadata(this.context, this.getOutputChannel());
  }

  private resolveModelMetadata(
    modelId: string,
    snapshot: CachedModelMetadataSnapshot,
  ): ResolvedModelMetadata {
    return resolveModelMetadata(
      modelId,
      this.baseVendor,
      snapshot,
      this.liveModelMetadataById,
    );
  }

  private replaceLiveModelMetadata(entries: ModelListEntry[] | undefined): void {
    this.liveModelMetadataById.clear();
    for (const entry of entries ?? []) {
      if (typeof entry.id !== "string" || !entry.id) {
        continue;
      }
      const metadata = normalizeLiveModelMetadata(entry);
      if (metadata) {
        this.liveModelMetadataById.set(entry.id, metadata);
      }
    }
  }

  private recentTransportSummariesStorageKey(): string {
    return `${RECENT_TRANSPORT_SUMMARY_STORAGE_PREFIX}.${this.definition.vendor}`;
  }

  private restoreRecentTransportSummaries(): void {
    const stored = this.context.globalState.get<RecentTransportSummary[]>(
      this.recentTransportSummariesStorageKey(),
      [],
    );

    if (!Array.isArray(stored) || !stored.length) {
      return;
    }

    this.recentTransportSummaries.push(
      ...stored.slice(-RECENT_TRANSPORT_SUMMARY_LIMIT),
    );
  }

  private persistRecentTransportSummaries(): void {
    void this.context.globalState.update(
      this.recentTransportSummariesStorageKey(),
      this.recentTransportSummaries,
    );
  }

  private recordTransportSummary(
    summary: TransportRequestSummary,
    endpointKind: string,
    metadataSource: string,
    requestInitiator: unknown,
  ): void {
    const initiator = typeof requestInitiator === "string"
      ? requestInitiator
      : requestInitiator === undefined || requestInitiator === null
        ? undefined
        : String(requestInitiator);

    this.recentTransportSummaries.push({
      ...summary,
      recordedAt: new Date().toISOString(),
      endpointKind,
      metadataSource,
      ...(initiator ? { requestInitiator: initiator } : {}),
    });

    if (this.recentTransportSummaries.length > RECENT_TRANSPORT_SUMMARY_LIMIT) {
      this.recentTransportSummaries.splice(
        0,
        this.recentTransportSummaries.length - RECENT_TRANSPORT_SUMMARY_LIMIT,
      );
    }

    this.persistRecentTransportSummaries();
  }

  private recentTransportDiagnosticsLines(): string[] {
    if (!this.recentTransportSummaries.length) {
      return ["No requests recorded in this extension host yet.", ""];
    }

    return this.recentTransportSummaries
      .slice()
      .reverse()
      .flatMap((summary, index) => {
        const status = summary.status ?? summary.abortedReason ?? "n/a";
        const cacheHitRatio = formatCacheHitRatio({
          promptTokens: summary.promptTokens,
          cachedTokens: summary.cachedTokens,
        });
        const lines = [
          `### ${index + 1}. ${summary.modelId}`,
          "",
          `- time: ${summary.recordedAt}`,
          `- endpoint: ${summary.endpointKind}`,
          `- initiator: ${summary.requestInitiator ?? "unknown"}`,
          `- metadataSource: ${summary.metadataSource}`,
          `- status: ${status}`,
          `- durationMs: ${summary.durationMs}`,
          `- ttfbMs: ${summary.ttfbMs ?? "n/a"}`,
          `- totalBytes: ${summary.totalBytes}`,
          `- totalEvents: ${summary.totalEvents}`,
          `- tokens: prompt=${summary.promptTokens ?? "n/a"}, completion=${summary.completionTokens ?? "n/a"}, total=${summary.totalTokens ?? "n/a"}, cached=${summary.cachedTokens ?? "n/a"}`,
          `- cacheHitRatio: ${cacheHitRatio ?? "n/a"}`,
          `- finishReason: ${summary.finishReason ?? "n/a"}`,
          `- requestId: ${summary.requestId ?? "n/a"}`,
          `- sessionId: ${summary.sessionId ?? "n/a"}`,
          `- url: ${summary.url}`,
        ];

        if (summary.rateLimitSummary) {
          lines.push(`- rateLimit: ${summary.rateLimitSummary}`);
        }
        if (summary.errorMessage) {
          lines.push(`- error: ${summary.errorMessage}`);
        }

        lines.push("");
        return lines;
      });
  }

  private async refreshMetadataAndModels(): Promise<void> {
    await clearOpenCodeModelMetadataCache(this.context);
    await this.fetchModels();
  }

  async manage(): Promise<void> {
    const apiKey = await this.context.secrets.get(SECRET_KEY);

    if (!apiKey) {
      await this.setApiKey();
      return;
    }

    const choice = await vscode.window.showQuickPick(
      [
        { label: "Set API Key", action: "set" as const },
        { label: "Clear API Key", action: "clear" as const },
        { label: "Test Connection", action: "test" as const },
        { label: "Refresh Models", action: "refresh" as const }
      ],
      {
        title: `Manage ${this.definition.displayName}`,
        placeHolder: "Choose an action"
      }
    );

    if (!choice) {
      return;
    }

    if (choice.action === "set") {
      await this.setApiKey();
      return;
    }

    if (choice.action === "clear") {
      await this.context.secrets.delete(SECRET_KEY);
      this.changeEmitter.fire();
      vscode.window.showInformationMessage("OpenCode Go API key cleared.");
      return;
    }

    if (choice.action === "test") {
      await this.testConnection();
      return;
    }

    await this.refreshMetadataAndModels();
    this.changeEmitter.fire();
    vscode.window.showInformationMessage(`${this.definition.displayName} models refreshed.`);
  }

  async testConnection(): Promise<void> {
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      vscode.window.showErrorMessage(`${this.definition.displayName}: No API key set. Use 'Set API Key' first.`);
      return;
    }

    const statusBar = vscode.window.setStatusBarMessage(`$(loading~spin) Testing ${this.definition.displayName} connection...`);
    this.log(`Testing connection to ${this.definition.chatCompletionsUrl}`);

    try {
      const response = await fetch(this.definition.chatCompletionsUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.definition.testModelId,
          messages: [{ role: "user", content: "reply with just: ok" }],
          max_tokens: 10,
          stream: false
        })
      });

      const responseText = await response.text();
      statusBar.dispose();
      this.log(`Test response (${response.status}): ${responseText}`);
      this.getOutputChannel().show(true);

      if (response.ok) {
        vscode.window.showInformationMessage(`${this.definition.displayName}: Connection OK (HTTP ${response.status}). Check Output panel for details.`);
      } else {
        vscode.window.showErrorMessage(`${this.definition.displayName}: Connection failed (HTTP ${response.status}). Check Output panel for details.`);
      }
    } catch (error) {
      statusBar.dispose();
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Test connection error: ${message}`);
      this.getOutputChannel().show(true);
      vscode.window.showErrorMessage(`${this.definition.displayName}: Connection error - ${message}`);
    }
  }

  async setApiKey(): Promise<void> {
    const apiKey = await vscode.window.showInputBox({
      title: "OpenCode Go API Key",
      prompt: "Paste your OpenCode Go API key. It will be stored securely in VS Code SecretStorage.",
      password: true,
      ignoreFocusOut: true
    });

    if (!apiKey) {
      return;
    }

    await this.context.secrets.store(SECRET_KEY, apiKey.trim());
    this.changeEmitter.fire();
    vscode.window.showInformationMessage("OpenCode Go API key saved.");
  }

  async showDiagnostics(): Promise<void> {
    const models = await vscode.lm.selectChatModels({ vendor: this.definition.vendor });
    const metadataSnapshot = await this.getMetadataSnapshot();
    const lines = models.map((model) => {
      const rawModelId = resolveRawModelId(model.id);
      const metadata = this.resolveModelMetadata(rawModelId, metadataSnapshot);
      const limits = modelLimits(metadata);
      return [
      `- ${rawModelId}`,
      `  rawModelId: ${rawModelId}`,
      `  name: ${model.name}`,
      `  family: ${model.family}`,
      `  vendor: ${model.vendor}`,
      `  version: ${model.version}`,
      `  maxInputTokens: ${model.maxInputTokens}`,
      `  advertisedMaxOutputTokens: ${limits.advertisedMaxOutputTokens}`,
      `  advertisedContextWindow: ${limits.advertisedContextWindow}`,
      `  apiMaxOutputTokens: ${limits.maxOutputTokens}`,
      `  metadataSource: ${metadata.source}`,
      `  supportsVision: ${metadata.supportsVision}`,
      `  status: ${metadata.status ?? "active"}`,
      `  thinkingFamily: ${thinkingFamily(rawModelId) ?? "none"}`,
      `  configurationSchema: ${JSON.stringify((model as unknown as { configurationSchema?: unknown }).configurationSchema ?? null)}`,
      ...(hasExplicitModelLimits(rawModelId, this.baseVendor) ? [] : ["  limits: using bundled fallback"])
      ].join("\n");
    });

    const content = [
      `# ${this.definition.displayName} Diagnostics`,
      "",
      "## Recent Requests",
      "",
      ...this.recentTransportDiagnosticsLines(),
      `## Models`,
      "",
      `Models visible through vscode.lm.selectChatModels({ vendor: "${this.definition.vendor}" }): ${models.length}`,
      "",
      ...lines
    ].join("\n");

    const doc = await vscode.workspace.openTextDocument({ content, language: "markdown" });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<OpenCodeModel[]> {
    let apiKey = getConfiguredApiKey(options as ConfiguredLanguageModelInfoOptions)
      // Agent variant providers inherit the API key from the base vendor's secret
      // when no explicit key is configured for them in the Manage panel.
      ?? (this.definition.isAgentVariant ? await this.context.secrets.get(SECRET_KEY) : undefined);

    if (!apiKey) {
      return [];
    }

    // When a non-agent provider resolves its API key via BYOK configuration,
    // persist it so that agent-variant providers (which have no BYOK entry)
    // can inherit it from the extension's secret storage.
    if (!this.definition.isAgentVariant) {
      const existing = await this.context.secrets.get(SECRET_KEY);
      if (existing !== apiKey) {
        await this.context.secrets.store(SECRET_KEY, apiKey);
      }
      // Trigger re-resolution on the matching agent provider so it can
      // discover the newly stored key and show up in the Agents window.
      const agentProvider = agentProvidersByBaseVendor.get(this.definition.vendor);
      if (agentProvider) {
        agentProvider.triggerChange();
      }
    }

    if (token.isCancellationRequested) {
      return [];
    }

    const models = await this.fetchModels();
    const settings = getSettings();
    const metadataSnapshot = await this.getMetadataSnapshot();

    return models.flatMap((modelId) => {
      const metadata = this.resolveModelMetadata(modelId, metadataSnapshot);
      const routing = resolveModelRouting(modelId, this.definition);
      const effectiveModelId = toEffectiveModelId(modelId, this.definition.vendor);
      const agentHostModelId = `${effectiveModelId}::agent-host`;
      const limits = modelLimits(metadata, settings);
      this.apiKeysByModelId.set(modelId, apiKey);
      this.apiKeysByModelId.set(effectiveModelId, apiKey);
      this.apiKeysByModelId.set(agentHostModelId, apiKey);

      const capacityNote = CAPACITY_LIMITED_MODEL_NOTES[modelId];
      const modalityBadges = formatModalityBadges(metadata);
      const baseDetail = this.baseVendor === ZEN_VENDOR && isFreeZenModel(modelId) ? "Free" : this.definition.displayName;
      const baseTooltip = `${this.definition.displayName} model: ${modelId}`;
      const configurationSchema = modelConfigurationSchema(modelId, metadata);

      const sharedFields: Omit<OpenCodeModel, "id" | "targetChatSessionType"> = {
        rawModelId: modelId,
        name: `${this.definition.modelNamePrefix} / ${formatModelName(modelId)}`,
        family: `${this.definition.isAgentVariant && this.definition.baseVendor ? this.definition.baseVendor : this.definition.vendor}-${modelId}-${MODEL_METADATA_REVISION}`,
        // Include effective limits in version so VS Code invalidates stale
        // picker metadata after limit changes (eg. 2M -> 262K corrections).
        version: `1.2.0-${MODEL_METADATA_REVISION}-${limits.contextWindow}-${limits.maxOutputTokens}`,
        detail: capacityNote
          ? `${baseDetail} • Limited capacity`
          : modalityBadges
            ? `${baseDetail} • ${modalityBadges}`
            : baseDetail,
        tooltip: capacityNote
          ? `${baseTooltip}\n\n${capacityNote}`
          : modalityBadges
            ? `${baseTooltip}\n\n${modalityBadges}`
            : baseTooltip,
        category: {
          label: this.definition.displayName,
          order: this.definition.categoryOrder
        },
        isUserSelectable: true,
        maxInputTokens: limits.advertisedMaxInputTokens,
        maxOutputTokens: limits.advertisedMaxOutputTokens,
        capabilities: modelCapabilities(metadata),
        endpointKind: routing.endpointKind,
        provider: this.definition,
        // Pricing fields (VS Code languageModelPricing proposal)
        ...modelPricingFields(modelId, this.baseVendor, metadata),
        // Inline so Copilot Chat picks up the Thinking submenu directly
        // (parity with zelosleone/Opencode-Go-For-Copilot pattern).
        ...(configurationSchema ? { configurationSchema } : {})
      };

      if (this.definition.isAgentVariant) {
        // Agent-host variant — only returned by agent providers.
        // targetChatSessionType must match the `type` declared in the
        // Copilot extension's chatSessions contribution:
        //   { "type": "copilotcli", "requiresCustomModels": true, ... }
        const agentHostInfo: OpenCodeModel = {
          ...sharedFields,
          id: agentHostModelId,
          targetChatSessionType: "copilotcli"
        };

        this.log(`Model registered (agents): id=${agentHostInfo.id} targetChatSessionType=copilotcli`);
        return [agentHostInfo];
      }

      // General variant — no targetChatSessionType → visible in Chat view
      const info: OpenCodeModel = { ...sharedFields, id: effectiveModelId };

      this.log(`Model registered: id=${info.id} family=${info.family} metadataSource=${metadata.source} endpointKind=${routing.endpointKind} endpointUrl=${routing.endpointUrl} configurationSchema=${configurationSchema ? JSON.stringify(configurationSchema) : "none"}`);

      return [info];
    });
  }

  async provideLanguageModelChatResponse(
    model: OpenCodeModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const apiKey =
      getConfiguredApiKey(options as ConfiguredLanguageModelResponseOptions)
      ?? this.apiKeysByModelId.get(model.id);

    if (!apiKey) {
      throw new Error(`${this.definition.displayName} API key is required. Use the ${this.definition.displayName} gear icon in Language Models to configure it, then reload the window.`);
    }

    const apiMessages = normalizeMessages(messages.flatMap((message) => convertMessage(message, this.reasoningContentByToolCallId)));
    const baseSettings = getSettings();
    const rawModelId = model.rawModelId ?? resolveRawModelId(model.id);
    // Apply per-request Thinking selection (from Copilot Chat submenu) on top
    // of the workspace default. The override only affects the current model
    // family; other families remain at their global defaults.
    const requestOverride = getRequestModelConfiguration(options);
    const settings: ApiSettings = {
      ...baseSettings,
      thinking: applyRequestThinkingOverride(rawModelId, baseSettings.thinking, requestOverride)
    };
    // Extract the context-size tier selected by the user (if any)
    const contextSizeOverride = typeof requestOverride?.contextSize === "number"
      ? requestOverride.contextSize
      : undefined;
    const metadataSnapshot = await this.getMetadataSnapshot();
    const metadata = this.resolveModelMetadata(rawModelId, metadataSnapshot);
    const routing = resolveModelRouting(rawModelId, this.definition);

    const limits = modelLimits(metadata, settings, contextSizeOverride);
    const hasImageInput = messagesHaveImages(apiMessages);
    const thinkingPayload = buildThinkingPayload(rawModelId, settings.thinking, hasImageInput);
    const requestHeaders = buildOpenCodeRequestHeaders(
      messages,
      options,
      rawModelId,
    );
    const outputChannel = this.getOutputChannel();
    const onTransportSummary = (summary: TransportRequestSummary) => {
      this.recordTransportSummary(
        summary,
        routing.endpointKind,
        metadata.source,
        options.requestInitiator,
      );
      updateUsageStatusBar(this.definition.displayName, rawModelId, summary);
      if (this.baseVendor === GO_VENDOR && goUsageTracker) {
        this.log(`[go-usage] Recording: provider=${summary.providerDisplayName} model=${summary.modelId} promptTokens=${summary.promptTokens ?? "n/a"} completionTokens=${summary.completionTokens ?? "n/a"} cachedTokens=${summary.cachedTokens ?? "n/a"} status=${summary.status ?? "n/a"} error=${summary.errorMessage ?? "none"}`);
        goUsageTracker.record(summary, metadata.cost);
        refreshGoUsageStatusBar();
        this.log(`[go-usage] After record: entries=${goUsageTracker.getSummary().today.requests}`);
      }
    };

    this.log(`Request: initiator=${options.requestInitiator} model=${model.id} rawModel=${rawModelId} endpoint=${routing.endpointKind} metadataSource=${metadata.source} messages=${apiMessages.length} session=${requestHeaders["x-opencode-session"]} request=${requestHeaders["x-opencode-request"]} modelConfiguration=${JSON.stringify(pickThinkingModelConfiguration(requestOverride))} thinking=${JSON.stringify(settings.thinking)} thinkingPayload=${JSON.stringify(thinkingPayload)}`);
    if (settings.debugReasoning) {
      this.log("Reasoning debug is enabled. Provider reasoning_content will be written to this output channel when available.");
    }

    try {
      const contextWindowOutputBuffer = limits.advertisedMaxOutputTokens;

      if (routing.endpointKind === "messages") {
        await runStreamAnthropicMessages({
          url: routing.endpointUrl,
          providerDisplayName: this.definition.displayName,
          apiKey,
          modelId: rawModelId,
          body: buildAnthropicMessagesRequestBody(rawModelId, apiMessages, options, settings, metadata, limits),
          requestHeaders,
          progress,
          token,
          output: outputChannel,
          debugReasoning: settings.debugReasoning,
          requestTimeoutMs: settings.requestTimeoutMs,
          streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
          contextWindowOutputBuffer,
          authHeaders: buildOpenCodeGatewayAuthHeaders("messages", apiKey),
          capacityLimitedModelNotes: CAPACITY_LIMITED_MODEL_NOTES,
          onTransportSummary,
          stripThinkTags: settings.stripThinkTags,
        });
        return;
      }

      if (routing.endpointKind === "responses") {
        await runStreamResponsesApi({
          url: routing.endpointUrl,
          providerDisplayName: this.definition.displayName,
          apiKey,
          modelId: rawModelId,
          body: buildResponsesRequestBody(rawModelId, apiMessages, options, settings, metadata, limits),
          authHeaders: buildOpenCodeGatewayAuthHeaders("responses", apiKey),
          requestHeaders,
          progress,
          token,
          output: outputChannel,
          debugReasoning: settings.debugReasoning,
          requestTimeoutMs: settings.requestTimeoutMs,
          streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
          contextWindowOutputBuffer,
          capacityLimitedModelNotes: CAPACITY_LIMITED_MODEL_NOTES,
          onTransportSummary,
          stripThinkTags: settings.stripThinkTags,
          onReasoningContent: (toolCallIds, reasoningContent) => {
          for (const toolCallId of toolCallIds) {
            this.reasoningContentByToolCallId.set(toolCallId, reasoningContent);
          }
          }
        });
        this.log(`Request completed: model=${model.id}`);
        return;
      }

      if (routing.endpointKind === "google") {
        await runStreamGoogleGenerateContent({
          url: routing.endpointUrl,
          providerDisplayName: this.definition.displayName,
          apiKey,
          modelId: rawModelId,
          body: buildGoogleGenerateContentBody(apiMessages, options, settings, limits),
          requestHeaders,
          progress,
          token,
          output: outputChannel,
          debugReasoning: settings.debugReasoning,
          requestTimeoutMs: settings.requestTimeoutMs,
          streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
          contextWindowOutputBuffer,
          authHeaders: buildOpenCodeGatewayAuthHeaders("google", apiKey),
          capacityLimitedModelNotes: CAPACITY_LIMITED_MODEL_NOTES,
          onTransportSummary,
          stripThinkTags: settings.stripThinkTags,
          onReasoningContent: (toolCallIds, reasoningContent) => {
          for (const toolCallId of toolCallIds) {
            this.reasoningContentByToolCallId.set(toolCallId, reasoningContent);
          }
          }
        });
        return;
      }

      await runStreamChatCompletions({
        url: routing.endpointUrl,
        providerDisplayName: this.definition.displayName,
        apiKey,
        modelId: rawModelId,
        body: buildChatCompletionsRequestBody(rawModelId, apiMessages, options, settings, metadata, limits),
        authHeaders: buildOpenCodeGatewayAuthHeaders("chat-completions", apiKey),
        requestHeaders,
        progress,
        token,
        output: outputChannel,
        debugReasoning: settings.debugReasoning,
        requestTimeoutMs: settings.requestTimeoutMs,
        streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
        contextWindowOutputBuffer,
        capacityLimitedModelNotes: CAPACITY_LIMITED_MODEL_NOTES,
        onTransportSummary,
        stripThinkTags: settings.stripThinkTags,
        onReasoningContent: (toolCallIds, reasoningContent) => {
          for (const toolCallId of toolCallIds) {
            this.reasoningContentByToolCallId.set(toolCallId, reasoningContent);
          }
        }
      });
      this.log(`Request completed: model=${model.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`ERROR model=${model.id}: ${message}`);
      this.getOutputChannel().show(true);
      if (error instanceof OpenCodeRequestError) {
        vscode.window.showErrorMessage(error.userMessage);
      }
      throw error;
    }
  }

  async provideTokenCount(
    _model: OpenCodeModel,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    return typeof text === "string"
      ? estimateTokenCount(text)
      : estimateChatMessageTokenCount(text);
  }

  private async fetchModels(): Promise<string[]> {
    try {
      const response = await fetch(this.definition.modelsUrl);

      if (!response.ok) {
        throw new Error(`Model list request failed (${response.status}): ${response.statusText}`);
      }

      const data = await response.json() as ModelListResponse;
      this.replaceLiveModelMetadata(data.data);
      const ids = data.data
        ?.map((model) => model.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .filter((id) => this.definition.filterModel?.(id) ?? true);

      return this.filterAvailableModels(ids?.length ? ids : this.definition.fallbackModels);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showWarningMessage(`Could not fetch ${this.definition.displayName} model list. Using bundled model list. ${message}`);
      return this.filterAvailableModels(this.definition.fallbackModels);
    }
  }

  private async filterAvailableModels(modelIds: string[]): Promise<string[]> {
    const uniqueModelIds = [...new Set(modelIds)];

    try {
      const metadataSnapshot = await this.getMetadataSnapshot();
      const filteredModelIds = uniqueModelIds.filter((modelId) =>
        !KNOWN_UNAVAILABLE_MODEL_IDS.has(modelId)
        && !shouldHideDeprecatedModel(modelId, this.baseVendor, metadataSnapshot)
      );

      const removedModelIds = uniqueModelIds.filter((modelId) => !filteredModelIds.includes(modelId));
      if (removedModelIds.length) {
        this.log(`Filtered unavailable/deprecated models: ${removedModelIds.join(", ")}`);
      }

      return filteredModelIds;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Could not fetch model status metadata from models.dev. Applying local unavailable model filter only. ${message}`);
      return uniqueModelIds.filter((modelId) => !KNOWN_UNAVAILABLE_MODEL_IDS.has(modelId));
    }
  }

}

function getConfiguredApiKey(options?: { configuration?: LanguageModelConfiguration }): string | undefined {
  const configuredApiKey = options?.configuration?.apiKey;
  return typeof configuredApiKey === "string" && configuredApiKey.trim() ? configuredApiKey.trim() : undefined;
}

async function clearOpenCodeModelMetadataCache(
  context: vscode.ExtensionContext,
): Promise<void> {
  modelMetadataSnapshot = undefined;
  modelMetadataRefreshPromise = undefined;
  await context.globalState.update(MODEL_METADATA_CACHE_KEY, undefined);
}

async function getOpenCodeModelMetadata(
  context: vscode.ExtensionContext,
  output?: vscode.OutputChannel,
): Promise<CachedModelMetadataSnapshot> {
  const cached =
    modelMetadataSnapshot ??
    context.globalState.get<CachedModelMetadataSnapshot>(
      MODEL_METADATA_CACHE_KEY,
    );
  if (cached) {
    modelMetadataSnapshot = cached;
    if (isFreshModelMetadata(cached)) {
      return cached;
    }
    void refreshOpenCodeModelMetadata(context, output);
    return cached;
  }

  return refreshOpenCodeModelMetadata(context, output);
}

async function refreshOpenCodeModelMetadata(
  context: vscode.ExtensionContext,
  output?: vscode.OutputChannel,
): Promise<CachedModelMetadataSnapshot> {
  if (modelMetadataRefreshPromise) {
    return modelMetadataRefreshPromise;
  }

  modelMetadataRefreshPromise = (async () => {
    const response = await fetch(MODELS_DEV_API_URL, {
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      throw new Error(`models.dev request failed (${response.status}): ${response.statusText}`);
    }

    const data = await response.json() as ModelsDevResponse;
    const snapshot = normalizeModelsDevSnapshot(data);
    modelMetadataSnapshot = snapshot;
    await context.globalState.update(MODEL_METADATA_CACHE_KEY, snapshot);
    output?.appendLine(
      `[metadata] refreshed models.dev cache go=${Object.keys(snapshot.providers[GO_VENDOR]).length} zen=${Object.keys(snapshot.providers[ZEN_VENDOR]).length}`,
    );
    return snapshot;
  })()
    .catch((error) => {
      const cached =
        modelMetadataSnapshot ??
        context.globalState.get<CachedModelMetadataSnapshot>(
          MODEL_METADATA_CACHE_KEY,
        );
      if (cached) {
        const message = error instanceof Error ? error.message : String(error);
        output?.appendLine(
          `[metadata] refresh failed, using cached snapshot: ${message}`,
        );
        modelMetadataSnapshot = cached;
        return cached;
      }

      const message = error instanceof Error ? error.message : String(error);
      const fallback = bundledModelMetadataSnapshot();
      output?.appendLine(
        `[metadata] refresh failed, using bundled snapshot: ${message}`,
      );
      modelMetadataSnapshot = fallback;
      return fallback;
    })
    .finally(() => {
      modelMetadataRefreshPromise = undefined;
    });

  return modelMetadataRefreshPromise;
}

function buildChatCompletionsRequestBody(
  modelId: string,
  messages: ApiMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: ApiSettings,
  metadata: ResolvedModelMetadata,
  limits: ModelLimits,
): Record<string, unknown> {
  const tools = mapOpenAiTools(options.tools);
  const thinkingPayload = buildThinkingPayload(modelId, settings.thinking, messagesHaveImages(messages));

  return {
    model: modelId,
    messages,
    // Only send temperature if the model supports it (not deprecated)
    ...(metadata.temperature !== false ? { temperature: settings.temperature } : {}),
    max_tokens: limits.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...thinkingPayload,
    ...(tools.length ? { tools, tool_choice: toolChoice(options.toolMode) } : {}),
  };
}

function buildAnthropicMessagesRequestBody(
  modelId: string,
  messages: ApiMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: ApiSettings,
  metadata: ResolvedModelMetadata,
  limits: ModelLimits,
): Record<string, unknown> {
  const tools = mapAnthropicTools(options.tools);
  const rawThinkingPayload = buildThinkingPayload(modelId, settings.thinking, messagesHaveImages(messages));
  // Qwen models routed to the Anthropic messages endpoint need thinking in
  // Anthropic-native format ({ type: "enabled"|"disabled" }) rather than the
  // Qwen-native enable_thinking boolean. If the payload contains
  // enable_thinking, translate it; otherwise pass through as-is.
  const thinkingPayload = /^qwen3(?:\.|-)/i.test(modelId) && ("enable_thinking" in rawThinkingPayload || "thinking_budget" in rawThinkingPayload)
    ? buildQwenAnthropicThinkingPayload(settings.thinking)
    : rawThinkingPayload;
  const anthropicMessages = buildAnthropicMessages(messages);

  return {
    model: modelId,
    // Only send temperature if the model supports it (not deprecated)
    ...(metadata.temperature !== false ? { temperature: settings.temperature } : {}),
    max_tokens: limits.maxOutputTokens,
    stream: true,
    messages: anthropicMessages,
    ...thinkingPayload,
    ...(tools.length
      ? { tools, tool_choice: anthropicToolChoice(options.toolMode) }
      : {}),
  };
}

function buildAnthropicMessages(messages: ApiMessage[]): AnthropicRequestMessage[] {
  let cacheControlCount = 0;
  const nextCacheControl = (): { cache_control?: AnthropicCacheControl } => {
    cacheControlCount += 1;
    return cacheControlCount <= 4
      ? { cache_control: { type: "ephemeral" } }
      : {};
  };

  const anthropicMessages: AnthropicRequestMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      const userBlocks = anthropicUserBlocks(message.content, nextCacheControl);
      if (userBlocks.length) {
        anthropicMessages.push({ role: "user", content: userBlocks });
      }
      continue;
    }

    if (message.role === "assistant") {
      const assistantBlocks = anthropicAssistantBlocks(message, nextCacheControl);
      if (assistantBlocks.length) {
        anthropicMessages.push({ role: "assistant", content: assistantBlocks });
      }
      continue;
    }

    if (message.role === "tool" && message.tool_call_id) {
      anthropicMessages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: joinedTextContent(message.content, "\n"),
          ...nextCacheControl(),
        }],
      });
    }
  }

  if (!anthropicMessages.length) {
    anthropicMessages.push({
      role: "user",
      content: [{ type: "text", text: "Continue the conversation.", ...nextCacheControl() }],
    });
  }

  return anthropicMessages;
}

function anthropicUserBlocks(
  content: ApiMessage["content"],
  nextCacheControl: () => { cache_control?: AnthropicCacheControl },
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return content.trim()
      ? [{ type: "text", text: content, ...nextCacheControl() }]
      : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
      blocks.push({ type: "text", text: part.text, ...nextCacheControl() });
      continue;
    }

    if (part.type === "image_url") {
      const source = anthropicImageSource(part);
      if (source) {
        blocks.push({ type: "image", source, ...nextCacheControl() });
      }
    }
  }

  return blocks;
}

function anthropicAssistantBlocks(
  message: ApiMessage,
  nextCacheControl: () => { cache_control?: AnthropicCacheControl },
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];

  const text = joinedTextContent(message.content);
  if (text) {
    blocks.push({ type: "text", text, ...nextCacheControl() });
  }

  for (const toolCall of message.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Math.random().toString(36).slice(2)}`,
      name: toolCall.function.name,
      input: anthropicToolCallInput(toolCall.function.arguments),
      ...nextCacheControl(),
    });
  }

  return blocks;
}

function anthropicToolCallInput(argumentsText: string): unknown {
  if (!argumentsText.trim()) {
    return {};
  }

  try {
    return JSON.parse(argumentsText);
  } catch {
    return argumentsText;
  }
}

function anthropicImageSource(
  part: OpenAiContentPart,
): AnthropicImageSource | undefined {
  if (part.type !== "image_url") {
    return undefined;
  }

  const url = part.image_url?.url;
  if (typeof url !== "string" || !url) {
    return undefined;
  }

  const match = /^data:([^;]+);base64,(.*)$/i.exec(url);
  if (match) {
    return {
      type: "base64",
      media_type: match[1],
      data: match[2],
    };
  }

  return { type: "url", url };
}

function mapResponsesTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): Array<Record<string, unknown>> {
  return (tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: sanitizeToolSchema(tool.inputSchema),
  }));
}

function buildResponsesRequestBody(
  modelId: string,
  messages: ApiMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: ApiSettings,
  metadata: ResolvedModelMetadata,
  limits: ModelLimits,
): Record<string, unknown> {
  const input = messages.flatMap((message) => responsesInputItemsFromMessage(message));
  const tools = mapResponsesTools(options.tools);

  return {
    model: modelId,
    input,
    max_output_tokens: limits.maxOutputTokens,
    // Only send temperature if the model supports it (not deprecated)
    ...(metadata.temperature !== false ? { temperature: settings.temperature } : {}),
    stream: true,
    ...(tools.length ? { tools, tool_choice: toolChoice(options.toolMode) } : {}),
    text: { verbosity: modelId === "gpt-5-codex" ? "medium" : "low" },
  };
}

function responsesInputItemsFromMessage(message: ApiMessage): Array<Record<string, unknown>> {
  if (message.role === "user") {
    const content = responsesUserContent(message.content);
    return content.length ? [{ role: "user", content }] : [];
  }

  if (message.role === "assistant") {
    const items: Array<Record<string, unknown>> = [];
    const text = responsesAssistantText(message.content);
    if (text) {
      items.push({ role: "assistant", content: [{ type: "output_text", text }] });
    }

    for (const toolCall of message.tool_calls ?? []) {
      items.push({
        type: "function_call",
        id: toolCall.id,
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }

    return items;
  }

  if (message.role === "tool") {
    return [{
      type: "function_call_output",
      call_id: message.tool_call_id ?? `tool-${Date.now()}`,
      output: typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? ""),
    }];
  }

  return [];
}

function responsesUserContent(content: ApiMessage["content"]): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part): Array<Record<string, unknown>> => {
    if (part.type === "text" && typeof part.text === "string") {
      return [{ type: "input_text", text: part.text }];
    }

    if (part.type === "image_url" && part.image_url?.url) {
      return [{ type: "input_image", image_url: { url: part.image_url.url } }];
    }

    return [];
  });
}

function responsesAssistantText(content: ApiMessage["content"]): string {
  return joinedTextContent(content);
}

function joinedTextContent(
  content: ApiMessage["content"],
  separator = "",
): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part): part is OpenAiContentPart & { text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(separator);
}

function buildGoogleGenerateContentBody(
  messages: ApiMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: ApiSettings,
  limits: ModelLimits,
): Record<string, unknown> {
  const tools = mapGoogleTools(options.tools);

  return {
    contents: googleContentsFromMessages(messages),
    generationConfig: {
      maxOutputTokens: limits.maxOutputTokens,
      temperature: settings.temperature,
    },
    ...(tools.length ? { tools: [{ functionDeclarations: tools }], toolConfig: googleToolConfig(options.toolMode) } : {}),
  };
}

function mapGoogleTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): Array<Record<string, unknown>> {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: sanitizeToolSchema(tool.inputSchema),
  }));
}

function googleToolConfig(mode: vscode.LanguageModelChatToolMode): Record<string, unknown> {
  return {
    functionCallingConfig: {
      mode: mode === vscode.LanguageModelChatToolMode.Required ? "ANY" : "AUTO",
    },
  };
}

function googleContentsFromMessages(messages: ApiMessage[]): Array<Record<string, unknown>> {
  const toolNamesById = new Map<string, string>();
  const contents: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "user") {
      const parts = googleUserParts(message.content);
      if (parts.length) {
        contents.push({ role: "user", parts });
      }
      continue;
    }

    if (message.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
        parts.push({ text: message.reasoning_content, thought: true });
      }
      const text = responsesAssistantText(message.content);
      if (text) {
        parts.push({ text });
      }
      for (const toolCall of message.tool_calls ?? []) {
        const args = parseToolInput(toolCall.function.arguments);
        parts.push({ functionCall: { name: toolCall.function.name, args } });
        toolNamesById.set(toolCall.id, toolCall.function.name);
      }
      if (parts.length) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (message.role === "tool" && message.tool_call_id) {
      const name = toolNamesById.get(message.tool_call_id) ?? "tool";
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name,
            response: { name, content },
          },
        }],
      });
    }
  }

  return contents;
}

function googleUserParts(content: ApiMessage["content"]): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part): Array<Record<string, unknown>> => {
    if (part.type === "text" && typeof part.text === "string") {
      return [{ text: part.text }];
    }

    if (part.type === "image_url" && part.image_url?.url) {
      const inlineData = dataUrlToInlineData(part.image_url.url);
      return inlineData ? [{ inlineData }] : [];
    }

    return [];
  });
}

function dataUrlToInlineData(url: string): { mimeType: string; data: string } | undefined {
  const match = /^data:(.+?);base64,(.+)$/i.exec(url);
  if (!match) {
    return undefined;
  }
  return {
    mimeType: match[1],
    data: match[2],
  };
}

function parseToolInput(value: string): object {
  if (!value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// The official OpenCode client sends these headers on every request. The Zen
// gateway reads x-opencode-session first, then converts that sticky identifier
// into provider-specific affinity headers such as x-session-affinity upstream.
//
// VS Code's provider API does not currently expose a guaranteed public session
// identifier everywhere, so we first probe a few known internal fields and then
// fall back to a stable hash of the first messages in the conversation. That
// preserves sticky routing and cache affinity without depending on hidden state.
function buildOpenCodeRequestHeaders(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  modelId: string,
): Record<string, string> {
  const sessionId = cleanHeaderValue(
    findStringOption(options, [
      "sessionId",
      "sessionID",
      "chatSessionId",
      "chatSessionID",
      "conversationId",
      "conversationID",
      "threadId",
      "threadID",
      "session.id",
      "chatSession.id",
    ]) ?? `vscode-${stableHash(conversationAnchor(messages, modelId))}`,
  );
  const requestId = cleanHeaderValue(
    findStringOption(options, [
      "requestId",
      "requestID",
      "messageId",
      "messageID",
    ]) ??
      `req-${stableHash(`${Date.now()}-${Math.random()}-${sessionId}-${modelId}`)}`,
  );

  return {
    "x-opencode-session": sessionId,
    "x-opencode-request": requestId,
    "x-opencode-client": OPEN_CODE_CLIENT,
    "User-Agent": OPEN_CODE_USER_AGENT,
  };
}

function findStringOption(
  options: unknown,
  paths: string[],
): string | undefined {
  for (const path of paths) {
    const value = readPath(options, path.split("."));
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function conversationAnchor(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  modelId: string,
): string {
  const anchorMessages = messages
    .slice(0, 3)
    .map((message) => `${message.role}:${messageText(message).slice(0, 2048)}`);
  return anchorMessages.length ? anchorMessages.join("\n") : modelId;
}

function cleanHeaderValue(value: string): string {
  const cleaned = value.replace(/[\r\n]/g, " ").trim();
  return cleaned ? cleaned.slice(0, 256) : "unknown";
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function mapOpenAiTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): OpenAiToolDefinition[] {
  return (tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: sanitizeToolSchema(tool.inputSchema)
    }
  }));
}

function mapAnthropicTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): AnthropicToolDefinition[] {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: sanitizeToolSchema(tool.inputSchema)
  }));
}

function sanitizeToolSchema(schema: unknown): object {
  const root = isRecord(schema) ? schema : { type: "object", properties: {} };
  const sanitized = sanitizeJsonSchemaNode(root, root, new Set());
  if (!isRecord(sanitized)) {
    return { type: "object", properties: {} };
  }

  return {
    type: sanitized.type === "object" ? "object" : "object",
    properties: isRecord(sanitized.properties) ? sanitized.properties : {},
    ...(Array.isArray(sanitized.required) ? { required: sanitized.required } : {})
  };
}

function sanitizeJsonSchemaNode(value: unknown, root: Record<string, unknown>, seenRefs: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonSchemaNode(item, root, seenRefs));
  }

  if (!isRecord(value)) {
    return value;
  }

  const ref = typeof value.$ref === "string" ? value.$ref : undefined;
  if (ref?.startsWith("#/") && !seenRefs.has(ref)) {
    const target = resolveJsonPointer(root, ref);
    if (target !== undefined) {
      const nextSeenRefs = new Set(seenRefs);
      nextSeenRefs.add(ref);
      const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
      const resolved = sanitizeJsonSchemaNode(target, root, nextSeenRefs);
      return isRecord(resolved)
        ? sanitizeJsonSchemaNode({ ...resolved, ...siblings }, root, nextSeenRefs)
        : sanitizeJsonSchemaNode(siblings, root, nextSeenRefs);
    }
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema" || key === "$id" || key === "$ref" || key === "$defs" || key === "definitions") {
      continue;
    }

    if (key === "properties" && isRecord(child)) {
      result.properties = Object.fromEntries(
        Object.entries(child).map(([propertyName, propertySchema]) => [
          propertyName,
          sanitizeJsonSchemaNode(propertySchema, root, seenRefs)
        ])
      );
      continue;
    }

    if (key === "items" || key === "additionalProperties") {
      result[key] = sanitizeJsonSchemaNode(child, root, seenRefs);
      continue;
    }

    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(child)) {
      result[key] = child.map((item) => sanitizeJsonSchemaNode(item, root, seenRefs));
      continue;
    }

    if (["type", "description", "enum", "required", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"].includes(key)) {
      result[key] = child;
    }
  }

  return result;
}

function resolveJsonPointer(root: Record<string, unknown>, pointer: string): unknown {
  return pointer
    .slice(2)
    .split("/")
    .reduce<unknown>((current, segment) => {
      if (!isRecord(current)) {
        return undefined;
      }
      return current[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    }, root);
}

function toolChoice(mode: vscode.LanguageModelChatToolMode): "auto" | "required" {
  return mode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
}

function anthropicToolChoice(mode: vscode.LanguageModelChatToolMode): { type: "auto" | "any" } {
  return { type: mode === vscode.LanguageModelChatToolMode.Required ? "any" : "auto" };
}

function convertMessage(
  message: vscode.LanguageModelChatRequestMessage,
  reasoningContentByToolCallId: ReadonlyMap<string, string>
): ApiMessage[] {
  const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user";
  const textParts: string[] = [];
  const imageParts: OpenAiContentPart[] = [];
  const toolCalls: OpenAiToolCall[] = [];
  const toolResults: ApiMessage[] = [];

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelToolCallPart) {
      toolCalls.push({
        id: part.callId,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input ?? {})
        }
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      toolResults.push({
        role: "tool",
        tool_call_id: part.callId,
        content: part.content.map(partToText).filter(Boolean).join("\n")
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) {
      const base64 = dataPartToBase64(part.data);
      imageParts.push({
        type: "image_url",
        image_url: { url: `data:${part.mimeType};base64,${base64}` }
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart && isInternalDataPart(part)) {
      continue;
    }

    const text = partToText(part);
    if (text) {
      textParts.push(text);
    }
  }

  // Build content: use multimodal array if images present, otherwise plain string
  const hasImages = imageParts.length > 0;
  const textContent = textParts.join("\n");

  let content: string | null | OpenAiContentPart[] = textContent;
  if (hasImages) {
    const multimodal: OpenAiContentPart[] = [];
    if (textContent) {
      multimodal.push({ type: "text", text: textContent });
    }
    multimodal.push(...imageParts);
    content = multimodal;
  }

  if (role === "assistant" && toolCalls.length) {
    return [{
      role,
      content: typeof content === "string" ? content || null : content,
      reasoning_content: reasoningForToolCalls(toolCalls, reasoningContentByToolCallId),
      tool_calls: toolCalls
    }];
  }

  if (toolResults.length) {
    return content ? [{ role, content }, ...toolResults] : toolResults;
  }

  return [{ role, content }];
}

function dataPartToBase64(data: Uint8Array): string {
  let output = "";

  for (let index = 0; index < data.length; index += 3) {
    const first = data[index] ?? 0;
    const second = data[index + 1] ?? 0;
    const third = data[index + 2] ?? 0;
    const chunk = (first << 16) | (second << 8) | third;

    output += BASE64_ALPHABET[(chunk >> 18) & 63];
    output += BASE64_ALPHABET[(chunk >> 12) & 63];
    output += index + 1 < data.length ? BASE64_ALPHABET[(chunk >> 6) & 63] : "=";
    output += index + 2 < data.length ? BASE64_ALPHABET[chunk & 63] : "=";
  }

  return output;
}

function reasoningForToolCalls(
  toolCalls: OpenAiToolCall[],
  reasoningContentByToolCallId: ReadonlyMap<string, string>
): string | undefined {
  const reasoning = toolCalls
    .map((toolCall) => reasoningContentByToolCallId.get(toolCall.id))
    .filter((value): value is string => Boolean(value?.trim()));

  return reasoning.length ? reasoning.join("\n") : undefined;
}

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content.map(partToText).filter(Boolean).join("\n");
}

function estimateChatMessageTokenCount(message: vscode.LanguageModelChatRequestMessage): number {
  const role = typeof message.role === "string" ? message.role : String(message.role);
  const name = typeof message.name === "string" ? message.name : "";
  const contentTokens = message.content
    .map(partToTokenCount)
    .reduce((total, count) => total + count, 0);

  return MESSAGE_TOKEN_OVERHEAD
    + estimateTokenCount(role)
    + (name ? MESSAGE_NAME_TOKEN_OVERHEAD + estimateTokenCount(name) : 0)
    + contentTokens;
}

function partToTokenCount(part: vscode.LanguageModelInputPart | unknown): number {
  if (part instanceof vscode.LanguageModelTextPart) {
    return estimateTokenCount(part.value);
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    const contentTokens = part.content
      .map(partToTokenCount)
      .reduce((total, count) => total + count, 0);
    return TOOL_RESULT_TOKEN_OVERHEAD
      + estimateTokenCount(part.callId)
      + contentTokens;
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return TOOL_CALL_TOKEN_OVERHEAD
      + estimateTokenCount(part.callId)
      + estimateTokenCount(part.name)
      + estimateStructuredTokenCount(part.input);
  }

  if (part instanceof vscode.LanguageModelDataPart) {
    return isInternalDataPart(part) ? 0 : estimateDataPartTokenCount(part);
  }

  if (typeof part === "string") {
    return estimateTokenCount(part);
  }

  if (isRecord(part)) {
    return estimateStructuredTokenCount(part);
  }

  return 0;
}

function estimateStructuredTokenCount(value: unknown): number {
  try {
    return estimateTokenCount(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function estimateDataPartTokenCount(part: vscode.LanguageModelDataPart): number {
  if (part.mimeType.startsWith("image/")) {
    return IMAGE_TOKEN_ESTIMATE;
  }

  if (part.mimeType.startsWith("text/") || part.mimeType === "application/json") {
    return estimateTokenCount(new TextDecoder().decode(part.data));
  }

  return Math.max(1, Math.ceil(part.data.byteLength / 4));
}

function partToText(part: vscode.LanguageModelInputPart | unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    return part.content.map(partToText).filter(Boolean).join("\n");
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return `[Tool call: ${part.name} ${JSON.stringify(part.input)}]`;
  }

  if (part instanceof vscode.LanguageModelDataPart && isInternalDataPart(part)) {
    return "";
  }

  if (typeof part === "string") {
    return part;
  }

  return "";
}

function normalizeMessages(messages: ApiMessage[]): ApiMessage[] {
  const normalized: ApiMessage[] = [];

  for (const message of messages) {
    if (!hasMessagePayload(message)) {
      continue;
    }

    const previous = normalized.at(-1);
    const prevContent = previous?.content;
    const msgContent = message.content;
    const prevIsString = typeof prevContent === "string";
    const msgIsString = typeof msgContent === "string";
    const prevHasToolCalls = !!(previous?.tool_calls?.length || previous?.tool_call_id);
    const msgHasToolCalls = !!(message.tool_calls?.length || message.tool_call_id);

    if (
      previous?.role === message.role
      && message.role !== "tool"
      && prevIsString && msgIsString
      && !prevHasToolCalls && !msgHasToolCalls
    ) {
      previous.content = `${prevContent ?? ""}\n\n${msgContent ?? ""}`.trim();
    } else {
      normalized.push({ ...message });
    }
  }

  if (normalized[0]?.role === "assistant") {
    normalized.unshift({
      role: "user",
      content: "Continue the conversation based on the prior assistant message."
    });
  }

  return normalized.length ? normalized : [{ role: "user", content: "" }];
}

function messagesHaveImages(messages: readonly ApiMessage[]): boolean {
  return messages.some((message) =>
    Array.isArray(message.content)
    && message.content.some((part) => part.type === "image_url")
  );
}

function hasMessagePayload(message: ApiMessage): boolean {
  if (message.tool_calls?.length || message.tool_call_id) {
    return true;
  }

  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }

  if (Array.isArray(message.content)) {
    return message.content.length > 0;
  }

  return false;
}

// Detect which Thinking family a raw model id belongs to. Used both to render
// the per-model picker submenu (configurationSchema) and to map the user's
// per-request selection back to the right OpenCode request field.
// Per-family JSON-Schema describing the native model-picker controls rendered
// by VS Code 1.120. Keep the primary property name aligned with VS Code's
// BYOK reasoning control so builds with narrower assumptions still recognize it.
// Accepts optional metadata for dynamic fallback: any model with
// `reasoning: true` in its resolved metadata gets a generic off/on schema
// even if no hardcoded family match exists.
function modelConfigurationSchema(
  modelId: string,
  metadata?: ResolvedModelMetadata,
): vscode.LanguageModelConfigurationSchema | undefined {
  const properties: Record<string, unknown> = {};

  // --- Thinking / Reasoning Effort ---
  // Priority 1: if models.dev provides explicit reasoning_options, use those.
  // Priority 2: fall back to family-based hardcoded values.
  // Priority 3: dynamic fallback for any model with reasoning: true.
  const builtinSchema = buildFamilyThinkingSchema(modelId, metadata);

  if (builtinSchema) {
    Object.assign(properties, builtinSchema.properties);
  }

  // --- Context Size (tiered pricing) ---
  const contextSizeOptions = metadata?.cost ? getContextSizeOptions(metadata.cost, metadata.contextWindow) : undefined;
  if (contextSizeOptions && contextSizeOptions.length > 0) {
    properties.contextSize = {
      type: "number",
      title: "Context Size",
      enum: contextSizeOptions.map(o => o.value),
      enumItemLabels: contextSizeOptions.map(o => o.label),
      enumDescriptions: contextSizeOptions.map(o => o.description),
      default: contextSizeOptions.find(o => o.isDefault)?.value ?? contextSizeOptions[0].value,
      group: "tokens"
    };
  }

  if (Object.keys(properties).length === 0) {
    return undefined;
  }

  return { type: "object", properties: properties as vscode.LanguageModelConfigurationSchema["properties"] };
}

/**
 * Build the thinking-effort portion of the configuration schema.
 * Delegated to `./thinking.ts` (pure, testable).
 */

// All thinking helpers (buildFamilyThinkingSchema, applyRequestThinkingOverride,
// buildThinkingPayload, buildQwenAnthropicThinkingPayload, thinkingFamily) are
// imported from ./thinking.ts at the top of this file.

function getRequestModelConfiguration(options: vscode.ProvideLanguageModelChatResponseOptions): Record<string, unknown> | undefined {
  // The field is `modelConfiguration` in the current proposed API; older
  // builds shipped it under `configuration` alongside the auth config. Accept
  // both shapes defensively so the picker keeps working across VS Code
  // versions.
  const opts = options as vscode.ProvideLanguageModelChatResponseOptions & {
    modelConfiguration?: Record<string, unknown>;
    configuration?: Record<string, unknown>;
  };
  return opts.modelConfiguration ?? opts.configuration;
}

function pickThinkingModelConfiguration(override: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!override) return undefined;
  const picked: Record<string, unknown> = {};
  for (const key of ["reasoningEffort", "thinkingMode", "thinkingBudget"]) {
    const value = override[key];
    if (typeof value === "string") {
      picked[key] = value;
    }
  }
  return Object.keys(picked).length ? picked : undefined;
}

function getSettings(): ApiSettings {
  const config = vscode.workspace.getConfiguration("opencodego");

  return {
    temperature: config.get("temperature", 0.2),
    maxOutputTokensOverride: config.get("maxTokens", 0),
    maxInputTokensOverride: config.get("maxInputTokens", 0),
    debugReasoning: config.get("debugReasoning", false),
    requestTimeoutMs:
      Math.max(config.get("requestTimeoutSeconds", DEFAULT_REQUEST_TIMEOUT_MS / 1000), 1) * 1000,
    streamIdleTimeoutMs:
      Math.max(
        config.get(
          "streamIdleTimeoutSeconds",
          DEFAULT_STREAM_IDLE_TIMEOUT_MS / 1000,
        ),
        1,
      ) * 1000,
    thinking: {
      deepseek: config.get<ThinkingSettings["deepseek"]>("thinking.deepseek", "off"),
      glm: config.get<ThinkingSettings["glm"]>("thinking.glm", "off"),
      kimi: config.get<ThinkingSettings["kimi"]>("thinking.kimi", "off"),
      minimax: config.get<ThinkingSettings["minimax"]>("thinking.minimax", "off"),
      qwen: config.get<ThinkingSettings["qwen"]>("thinking.qwen", "off"),
      qwenBudget: config.get<ThinkingSettings["qwenBudget"]>("thinking.qwenBudget", "auto"),
      mimo: config.get<ThinkingSettings["mimo"]>("thinking.mimo", "off"),
    },
    stripThinkTags: config.get<ApiSettings["stripThinkTags"]>("stripThinkTags", "auto"),
  };
}

// buildThinkingPayload and buildQwenAnthropicThinkingPayload are imported from
// ./thinking.ts (pure, testable).



function modelLimits(
  metadata: ResolvedModelMetadata,
  settings = getSettings(),
  contextSizeOverride?: number,
): ModelLimits {
  const baseContextWindow = positiveOverride(settings.maxInputTokensOverride) ?? metadata.contextWindow;
  // If the user selected a specific context size tier, cap the window to that
  const contextWindow = contextSizeOverride !== undefined
    ? Math.min(baseContextWindow, contextSizeOverride)
    : baseContextWindow;
  const maxOutputTokens = positiveOverride(settings.maxOutputTokensOverride) ?? metadata.maxOutputTokens;
  const apiMaxOutputTokens = Math.min(maxOutputTokens, contextWindow);
  // advertisedContextWindow = actual model context window (not inflated).
  // Adding apiMaxOutputTokens here inflates the value above the real limit,
  // which causes VS Code to round up and display "2M" instead of "1M" for a
  // 1M-context model, and worse: VS Code may try to send payloads larger than
  // the model's actual total context window.
  const advertisedContextWindow = contextWindow;
  const advertisedMaxOutputTokens = Math.max(1, Math.min(apiMaxOutputTokens, UI_OUTPUT_TOKEN_RESERVE));

  return {
    contextWindow,
    maxOutputTokens: apiMaxOutputTokens,
    advertisedContextWindow,
    advertisedMaxInputTokens: Math.max(1, advertisedContextWindow - advertisedMaxOutputTokens),
    advertisedMaxOutputTokens
  };
}

function estimateTokenCount(value: string): number {
  if (!value) {
    return 0;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return 0;
  }

  const cjkCharacters = normalized.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const words = normalized.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu)?.length ?? 0;
  const charEstimate = Math.ceil(normalized.length / 4);

  return Math.max(1, Math.ceil(Math.max(words * 1.15, charEstimate, cjkCharacters)));
}

function positiveOverride(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function modelCapabilities(metadata: ResolvedModelMetadata): CopilotCompatibleCapabilities {
  // Mirrors the official shape used by `copilotChat`/`byok` providers:
  // `imageInput` and `toolCalling` are the raw proposed-API fields VS Code
  // maps to `vision` / `toolCalling` / `agentMode` internally, while
  // `supportsImageToText` and `supportsToolCalling` are the runtime API
  // booleans consumed by the `vscode.lm` callers in extensions.
  const supportsVision = metadata.supportsVision;
  return {
    imageInput: supportsVision,
    toolCalling: true,
    supportsImageToText: supportsVision,
    supportsToolCalling: true,
  };
}

function formatModalityBadges(metadata: ResolvedModelMetadata): string {
  const badges: string[] = [];
  if (metadata.supportsVision) {
    badges.push("Image");
  }
  if (metadata.supportsPdf) {
    badges.push("PDF");
  }
  if (metadata.supportsVideo) {
    badges.push("Video");
  }
  if (metadata.supportsAudio && !metadata.supportsVideo && !metadata.supportsPdf) {
    badges.push("Audio");
  }
  if (metadata.supportsAudio && (metadata.supportsVideo || metadata.supportsPdf)) {
    badges.push("Audio");
  }
  return badges.join(" · ");
}

function shouldHideDeprecatedModel(
  modelId: string,
  vendor: ProviderDefinition["vendor"],
  snapshot: CachedModelMetadataSnapshot,
): boolean {
  if (resolveBaseVendor(vendor) !== ZEN_VENDOR) {
    return false;
  }
  return snapshot.providers[ZEN_VENDOR]?.[modelId]?.status === "deprecated";
}

function resolveRawModelId(modelId: string): string {
  const [base] = modelId.split("::");
  const prefixes = [`${GO_VENDOR}:`, `${ZEN_VENDOR}:`, `${AGENT_GO_VENDOR}:`, `${AGENT_ZEN_VENDOR}:`];
  for (const prefix of prefixes) {
    if (base.startsWith(prefix)) {
      return base.slice(prefix.length);
    }
  }
  return base;
}

function isFreeZenModel(modelId: string): boolean {
  return modelId.endsWith("-free") || FREE_ZEN_MODEL_IDS.has(modelId);
}

function isFreeModel(modelId: string, vendor: ProviderDefinition["vendor"]): boolean {
  return (
    FREE_ZEN_MODEL_IDS.has(modelId) ||
    modelId.endsWith("-free")
  );
}

/**
 * Returns pricing fields for VS Code's language model pricing proposal
 * (`vscode.proposed.languageModelPricing`).
 *
 * Cost data from models.dev is in USD; VS Code expects AI Credits
 * (1 credit = $0.01 USD). We convert by multiplying by 100 so the
 * pricing table shows values comparable to Copilot's own models.
 *
 * The `pricing` string matches the format used by the Copilot extension's
 * `formatPricingLabel` (`In: $X · Out: $Y /1M tokens`) so the picker hover
 * reads consistently across providers.
 */
function modelPricingFields(
  modelId: string,
  vendor: ProviderDefinition["vendor"],
  metadata: ResolvedModelMetadata,
): {
  pricing?: string;
  priceCategory?: string;
  inputCost?: number;
  outputCost?: number;
  cacheCost?: number;
} {
  const free = isFreeModel(modelId, vendor);

  if (free) {
    return { pricing: "Free", priceCategory: "low" };
  }

  const cost = metadata.cost;
  if (cost) {
    const inputCredits = Math.round(cost.input * 100);
    const outputCredits = Math.round(cost.output * 100);
    const cacheCredits = cost.cache_read !== undefined
      ? Math.round(cost.cache_read * 100)
      : undefined;

    const fmt = (v: number) => `$${v.toFixed(v < 0.1 ? 2 : 1)}`;
    return {
      pricing: `In: ${fmt(cost.input)} · Out: ${fmt(cost.output)} /1M tokens`,
      priceCategory: costCategory(cost),
      inputCost: inputCredits,
      outputCost: outputCredits,
      ...(cacheCredits !== undefined ? { cacheCost: cacheCredits } : {}),
    };
  }

  // No models.dev cost data: fall back to a neutral label so the picker
  // shows something instead of pretending we know the price.
  return {
    pricing: `${vendor === GO_VENDOR ? "Go" : "Zen"} subscription`,
  };
}

/**
 * Maps per-million-token USD cost to the four-tier `priceCategory` labels
 * (`low` / `medium` / `high` / `very_high`) that VS Code's language model
 * picker renders as a visual cost indicator.
 *
 * VS Code's own `getPriceCategoryLabel` (chatModelPicker.ts) just translates
 * the string but does not assign thresholds - the Copilot extension uses
 * billing multipliers and a weighted 3:1 input:output blend to mirror the
 * user's billing mix. We follow the same 3:1 weighting here so our category
 * lines up with what the user sees for the official Copilot models:
 *
 * - low       : qwen3.5-plus, deepseek-v4-flash-free, mimo-v2-flash-free
 * - medium    : kimi-k2.6, gemini-3-flash, claude-haiku-4-5, gpt-5,
 *               gpt-5.2, gpt-5.4, claude-sonnet-4-6
 * - high      : claude-opus-4-5, claude-opus-4-7, gpt-5.5
 * - very_high : gpt-5.4-pro, gpt-5.5-pro, claude-opus-4-1
 *
 * Free models (`cost.input == 0 && cost.output == 0`) are reported as `low`
 * because that is the bucket VS Code uses for "Free" entries in the picker.
 */
function costCategory(cost: { input: number; output: number }): string {
  if (cost.input <= 0 && cost.output <= 0) {
    return "low";
  }
  // Mirrors Copilot's 3:1 input:output blend (input tokens are usually the
  // larger share of a request, so they get more weight than raw sum).
  const weighted = cost.input * 3 + cost.output;
  if (weighted <= 2) return "low";
  if (weighted <= 25) return "medium";
  if (weighted <= 50) return "high";
  return "very_high";
}

function formatModelName(modelId: string): string {
  const parts = modelId.split("-");
  const displayParts: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (/^\d+$/.test(part) && /^\d+$/.test(parts[index + 1] ?? "")) {
      const versionParts = [part];

      while (/^\d+$/.test(parts[index + 1] ?? "")) {
        versionParts.push(parts[index + 1]);
        index += 1;
      }

      displayParts.push(versionParts.join("."));
      continue;
    }

    displayParts.push(part);
  }

  return displayParts
    .map((part) => part.toUpperCase() === part ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
