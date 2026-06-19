/**
 * VS Code InlineCompletionItemProvider for OpenCode autocomplete.
 *
 * VS Code cancels inline suggestion queries aggressively. Remote LLM requests
 * are much slower than that lifecycle, so the provider runs them in the
 * background, caches successful results, and asks VS Code to query again when
 * a cached item is ready.
 */

import * as vscode from "vscode";
import type { AutocompleteConfig } from "./types";
import { DEFAULT_AUTOCOMPLETE_CONFIG } from "./types";
import { AutocompleteSession, SessionManager } from "./session";
import { streamSession } from "./streamer";

const AUTOCOMPLETE_SECRET_KEY = "opencodego.apiKey";
const RESULT_CACHE_TTL_MS = 15_000;

interface ActiveRequest {
  controller: AbortController;
  documentUri: string;
  fingerprint: string;
  startedAt: number;
}

interface CompletionRequest {
  apiKey: string;
  document: vscode.TextDocument;
  inlineContext: vscode.InlineCompletionContext;
  position: vscode.Position;
  snapshot: CodeContextSnapshot;
  startedAt: number;
}

interface CachedResult {
  fingerprint: string;
  createdAt: number;
  list: vscode.InlineCompletionList;
}

interface CodeContextSnapshot {
  /** Code before the cursor (assistant prefix) */
  beforeCursor: string;
  /** Code after the cursor (for context) */
  afterCursor: string;
  /** Cache fingerprint */
  fingerprint: string;
}

function emptyList(): vscode.InlineCompletionList {
  return new vscode.InlineCompletionList([]);
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

function stripMarkdownFences(text: string): string {
  let result = text.replace(/\r\n/g, "\n").replace(/<CURSOR>/g, "");

  result = result.replace(/^\s*```[^\n]*\n/, "");
  result = result.replace(/\n\s*```\s*$/, "");
  result = result.replace(/^```[^\n]*\n/gm, "");
  result = result.replace(/^\s*```\s*$/gm, "");

  return result.replace(/\s+$/g, "");
}

function removeOverlappingPrefix(completion: string, beforeCursor: string): string {
  const maxOverlap = Math.min(completion.length, beforeCursor.length, 160);

  for (let length = maxOverlap; length >= 3; length--) {
    if (completion.startsWith(beforeCursor.slice(-length))) {
      return completion.slice(length);
    }
  }

  return completion;
}

function toEditorEol(text: string, document: vscode.TextDocument): string {
  if (document.eol === vscode.EndOfLine.CRLF) {
    return text.replace(/\n/g, "\r\n");
  }

  return text.replace(/\r\n/g, "\n");
}

export class PersistentAutocompleteProvider implements vscode.InlineCompletionItemProvider {
  private readonly _context: vscode.ExtensionContext;
  private readonly _output: vscode.OutputChannel;
  private readonly _sessionManager: SessionManager;
  private _enabled: boolean;
  private _config: AutocompleteConfig;
  private _apiKey: string | undefined;
  private _activeRequest: ActiveRequest | undefined;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _lastResult: CachedResult | undefined;
  private _pendingRequest: CompletionRequest | undefined;
  private _queuedRequest: CompletionRequest | undefined;
  private _statusBar: vscode.StatusBarItem;
  private _statusTimer: ReturnType<typeof setTimeout> | undefined;
  private _loggedMissingKey = false;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    config?: Partial<AutocompleteConfig>,
  ) {
    this._context = context;
    this._output = outputChannel;
    this._config = { ...DEFAULT_AUTOCOMPLETE_CONFIG, ...config };
    this._enabled = vscode.workspace
      .getConfiguration("opencodego")
      .get("autocomplete.enable", false);
    this._sessionManager = new SessionManager(this._config);

    this._statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      93,
    );

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("opencodego.autocomplete")) {
          this._reloadConfig();
        }
      }),
      context.secrets.onDidChange((event) => {
        if (event.key === AUTOCOMPLETE_SECRET_KEY) {
          void this._refreshApiKey();
        }
      }),
    );

    void this._refreshApiKey();
    this._setStatus("idle");
    this._log(`initialized enabled=${this._enabled} model=${this._config.modelId}`);
  }

  provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    inlineContext: vscode.InlineCompletionContext,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.InlineCompletionList> {
    if (!this._enabled || !this._isSupportedDocument(document)) {
      return emptyList();
    }

    if (this._shouldSkipPosition(document, position, inlineContext)) {
      return emptyList();
    }

    if (!this._apiKey) {
      void this._refreshApiKey();
      return emptyList();
    }

    const snapshot = this._buildCodeContext(document, position);
    const cached = this._getCachedResult(snapshot.fingerprint);
    if (cached) {
      this._log(`cache hit fingerprint=${snapshot.fingerprint}`);
      return cached;
    }

    this._scheduleRequest({
      apiKey: this._apiKey,
      document,
      inlineContext,
      position,
      snapshot,
      startedAt: Date.now(),
    });

    return emptyList();
  }

  private _scheduleRequest(request: CompletionRequest): void {
    this._pendingRequest = request;

    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }

    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = undefined;
      this._startPendingRequest();
    }, this._config.debounceMs);
  }

  private _startPendingRequest(): void {
    const request = this._pendingRequest;
    this._pendingRequest = undefined;

    if (!request || !this._enabled) {
      return;
    }

    const cached = this._getCachedResult(request.snapshot.fingerprint);
    if (cached) {
      this._triggerInlineSuggest("pending request already cached");
      return;
    }

    const active = this._activeRequest;
    if (active) {
      if (active.fingerprint === request.snapshot.fingerprint) {
        this._log(`already running fingerprint=${request.snapshot.fingerprint}`);
        return;
      }

      // Queue the request but do NOT abort the active one.
      // Let it complete — aborting causes "This operation was aborted" and
      // the queued one likely gets aborted too (cascade). Instead, let the
      // active request finish, then start the queued one.
      this._queuedRequest = request;
      this._log(
        `queued latest fingerprint=${request.snapshot.fingerprint} ` +
        `behind active=${active.fingerprint}`,
      );
      return;
    }

    this._beginRequest(request);
  }

  private _beginRequest(request: CompletionRequest): void {
    const activeRequest: ActiveRequest = {
      controller: new AbortController(),
      documentUri: request.document.uri.toString(),
      fingerprint: request.snapshot.fingerprint,
      startedAt: request.startedAt,
    };

    this._activeRequest = activeRequest;
    void this._executeActiveRequest(activeRequest, request);
  }

  private async _executeActiveRequest(
    activeRequest: ActiveRequest,
    request: CompletionRequest,
  ): Promise<void> {
    try {
      const session = this._sessionManager.getOrCreate(activeRequest.documentUri);
      this._setStatus("loading");
      this._log(
        `request start session=${session.id} model=${this._config.modelId} ` +
        `cacheWarm=${session.info.cacheWarmed} docVersion=${request.document.version}`,
      );

      const list = await this._runCompletionRequest(
        request.document,
        request.position,
        request.inlineContext,
        session,
        request.snapshot,
        request.apiKey,
        activeRequest.controller.signal,
      );

      if (list.items.length > 0 && !activeRequest.controller.signal.aborted) {
        this._lastResult = {
          fingerprint: request.snapshot.fingerprint,
          createdAt: Date.now(),
          list,
        };
        this._triggerInlineSuggest("completion cached");
      }

      const elapsed = Date.now() - activeRequest.startedAt;
      this._log(`request end elapsed=${elapsed}ms items=${list.items.length}`);
    } finally {
      if (this._activeRequest === activeRequest) {
        this._activeRequest = undefined;
      }

      const queued = this._queuedRequest;
      this._queuedRequest = undefined;
      if (queued && this._enabled) {
        this._beginRequest(queued);
      }
    }
  }

  private async _runCompletionRequest(
    document: vscode.TextDocument,
    position: vscode.Position,
    inlineContext: vscode.InlineCompletionContext,
    session: AutocompleteSession,
    snapshot: CodeContextSnapshot,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<vscode.InlineCompletionList> {
    const result = await streamSession({
      url: `${this._config.gatewayUrl}/chat/completions`,
      apiKey,
      config: this._config,
      messages: session.sessionStartMessages.slice(),
      beforeCursor: snapshot.beforeCursor,
      afterCursor: snapshot.afterCursor,
      signal,
      output: this._output,
    });

    if (result.cancelled || signal.aborted) {
      this._setStatus("idle");
      return emptyList();
    }

    if (result.error) {
      this._log(`stream error: ${result.error}`);
      this._setStatus("error");
      return emptyList();
    }

    const completion = this._normalizeCompletion(
      result.accumulatedText,
      snapshot.beforeCursor,
      document,
    );

    if (!completion) {
      this._log(
        `empty completion cycles=${result.cycles.length} tokens=${result.totalTokens} ` +
        `reasoning=${result.cycles.some((cycle) => cycle.hadReasoning)}`,
      );
      this._setStatus("idle");
      return emptyList();
    }

    session.markRequestComplete(result.totalTokens);

    const range = inlineContext.selectedCompletionInfo?.range ?? new vscode.Range(position, position);
    const insertText = this._withSelectedCompletionPrefix(
      completion,
      inlineContext.selectedCompletionInfo,
    );
    const item = new vscode.InlineCompletionItem(insertText, range);
    item.filterText = insertText;
    item.command = {
      command: "opencodego.autocompleteAccepted",
      title: "Autocomplete Accepted",
      arguments: [{
        sessionId: session.id,
        model: this._config.modelId,
        length: insertText.length,
      }],
    };

    this._log(
      `completion ready chars=${insertText.length} cycles=${result.cycles.length} ` +
      `tokens=${result.totalTokens} tool=${result.hadToolCall}`,
    );
    this._log(`preview=${JSON.stringify(insertText.slice(0, 160))}`);
    this._setStatus("success");

    return new vscode.InlineCompletionList([item]);
  }

  private _normalizeCompletion(
    rawText: string,
    beforeCursor: string,
    document: vscode.TextDocument,
  ): string {
    const withoutMarkdown = stripMarkdownFences(rawText);
    const withoutOverlap = removeOverlappingPrefix(withoutMarkdown, beforeCursor);
    return toEditorEol(withoutOverlap, document);
  }

  private _withSelectedCompletionPrefix(
    completion: string,
    selectedInfo: vscode.SelectedCompletionInfo | undefined,
  ): string {
    if (!selectedInfo?.text || completion.startsWith(selectedInfo.text)) {
      return completion;
    }

    return `${selectedInfo.text}${completion}`;
  }

  private _buildCodeContext(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): CodeContextSnapshot {
    const allLines = document.getText().split("\n");
    const cursorOffset = document.offsetAt(position);

    // 10 lines before cursor — minimal context for fast autocomplete.
    const startLine = Math.max(0, position.line - 10);
    const beforeLines = allLines.slice(startLine, position.line);
    const beforeLinePrefix = (allLines[position.line] ?? "").slice(0, position.character);
    const beforeCursor = [...beforeLines, beforeLinePrefix].join("\n");

    // 10 lines after cursor for context (closing braces, etc.).
    const endLine = Math.min(allLines.length, position.line + 10);
    const afterCursor = allLines.slice(position.line, endLine).join("\n");

    // No complex prompt needed — the streamer constructs messages using the
    // assistant prefix pattern: [system, user(suffix), assistant(beforeCursor)].
    // The model naturally continues the assistant message with the completion.
    const fingerprint = [
      document.uri.toString(),
      document.version,
      position.line,
      position.character,
      hashString(beforeCursor.slice(-200)),
    ].join(":");

    return {
      beforeCursor,
      afterCursor,
      fingerprint,
    };
  }

  private _isSupportedDocument(document: vscode.TextDocument): boolean {
    return document.uri.scheme === "file" || document.uri.scheme === "untitled";
  }

  private _shouldSkipPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    inlineContext: vscode.InlineCompletionContext,
  ): boolean {
    if (position.line >= document.lineCount) {
      return true;
    }

    const line = document.lineAt(position.line).text;
    const beforeCursor = line.slice(0, position.character);
    const trimmed = beforeCursor.trimStart();

    if (inlineContext.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      if (!beforeCursor.trim() && position.character === 0) {
        return true;
      }

      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("<!--")
      ) {
        return true;
      }
    }

    return false;
  }

  private _getCachedResult(fingerprint: string): vscode.InlineCompletionList | undefined {
    if (
      this._lastResult?.fingerprint === fingerprint &&
      Date.now() - this._lastResult.createdAt < RESULT_CACHE_TTL_MS
    ) {
      return this._lastResult.list;
    }

    return undefined;
  }

  private _triggerInlineSuggest(reason: string): void {
    this._log(`triggering inline suggest (${reason})`);
    setTimeout(() => {
      void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger").then(
        undefined,
        (error) => {
          this._log(
            `inline suggest trigger failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    }, 0);
  }

  private async _refreshApiKey(): Promise<void> {
    this._apiKey = await this._context.secrets.get(AUTOCOMPLETE_SECRET_KEY);

    if (!this._apiKey && this._enabled && !this._loggedMissingKey) {
      this._loggedMissingKey = true;
      this._log("OpenCode Go API key not found; run 'OpenCode Go: Set API Key'.");
    }

    if (this._apiKey) {
      this._loggedMissingKey = false;
    }

    this._setStatus("idle");
  }

  private _reloadConfig(): void {
    const cfg = vscode.workspace.getConfiguration("opencodego");
    const previousModel = this._config.modelId;
    this._enabled = cfg.get("autocomplete.enable", false);
    this._config = {
      ...this._config,
      modelId: cfg.get("autocomplete.model", DEFAULT_AUTOCOMPLETE_CONFIG.modelId),
      maxTokensPerCycle: cfg.get("autocomplete.maxTokens", DEFAULT_AUTOCOMPLETE_CONFIG.maxTokensPerCycle),
      debounceMs: cfg.get("autocomplete.debounceMs", DEFAULT_AUTOCOMPLETE_CONFIG.debounceMs),
      maxLoopCycles: cfg.get("autocomplete.maxLoopCycles", DEFAULT_AUTOCOMPLETE_CONFIG.maxLoopCycles),
      useToolLoop: cfg.get("autocomplete.useToolLoop", DEFAULT_AUTOCOMPLETE_CONFIG.useToolLoop),
      maxInputTokens: cfg.get("autocomplete.maxInputTokens", DEFAULT_AUTOCOMPLETE_CONFIG.maxInputTokens),
    };
    this._sessionManager.updateConfig(this._config);
    this._lastResult = undefined;
    this._clearPendingWork();

    if (!this._enabled || previousModel !== this._config.modelId) {
      this._sessionManager.destroyAll();
    }

    this._setStatus("idle");
    this._log(
      `config reloaded enabled=${this._enabled} model=${this._config.modelId} ` +
      `toolLoop=${this._config.useToolLoop}`,
    );
  }

  setModel(modelId: string): void {
    this._config.modelId = modelId;
    this._sessionManager.updateConfig({ modelId });
    this._sessionManager.destroyAll();
    this._lastResult = undefined;
    this._clearPendingWork();
    this._setStatus("idle");
    this._log(`model changed to ${modelId}`);
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    this._lastResult = undefined;

    if (!enabled) {
      this._sessionManager.destroyAll();
      this._clearPendingWork();
    }

    this._setStatus("idle");
    this._log(`autocomplete ${enabled ? "enabled" : "disabled"}`);
  }

  private _clearPendingWork(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = undefined;
    }

    this._activeRequest?.controller.abort();
    this._activeRequest = undefined;
    this._pendingRequest = undefined;
    this._queuedRequest = undefined;
  }

  private _setStatus(state: "idle" | "loading" | "success" | "error"): void {
    if (this._statusTimer) {
      clearTimeout(this._statusTimer);
      this._statusTimer = undefined;
    }

    if (!this._enabled) {
      this._statusBar.hide();
      return;
    }

    this._statusBar.show();

    if (!this._apiKey) {
      this._statusBar.text = "$(key) OpenCode AC";
      this._statusBar.tooltip = "OpenCode Autocomplete: API key missing";
      return;
    }

    switch (state) {
      case "loading":
        this._statusBar.text = "$(sync~spin) OpenCode AC";
        this._statusBar.tooltip = `OpenCode Autocomplete: generating with ${this._config.modelId}`;
        break;
      case "success":
        this._statusBar.text = "$(sparkle) OpenCode AC";
        this._statusBar.tooltip = "OpenCode Autocomplete: completion ready";
        this._statusTimer = setTimeout(() => this._setStatus("idle"), 2000);
        break;
      case "error":
        this._statusBar.text = "$(warning) OpenCode AC";
        this._statusBar.tooltip = "OpenCode Autocomplete: request failed";
        this._statusTimer = setTimeout(() => this._setStatus("idle"), 3000);
        break;
      default:
        this._statusBar.text = "$(sparkle) OpenCode AC";
        this._statusBar.tooltip = `OpenCode Autocomplete: ${this._config.modelId}`;
    }
  }

  private _log(message: string): void {
    this._output.appendLine(`[persistent-ac] ${message}`);
  }

  dispose(): void {
    this._clearPendingWork();
    this._sessionManager.destroyAll();
    this._statusBar.dispose();
    if (this._statusTimer) {
      clearTimeout(this._statusTimer);
    }
  }
}
