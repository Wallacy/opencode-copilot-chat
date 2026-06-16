/**
 * VS Code InlineCompletionItemProvider for persistent autocomplete.
 *
 * Integrates:
 *   - Session Manager (context retention across requests)
 *   - Stream Accumulator (SSE parsing + text accumulation)
 *   - Throttle (debounce + cancellation)
 *
 * How it works:
 *   1. User types → provideInlineCompletionItems is called
 *   2. Provider extracts code context around cursor
 *   3. Session maintains conversation history (cache warm after first request)
 *   4. Stream runs with tool-use loop (model calls wait_for_input)
 *   5. Accumulated text returned as InlineCompletionItem
 *   6. Session stays alive for next request (context retained)
 *
 * Configuration:
 *   - opencodego.autocomplete.model: Model ID (default: "mimo-v2.5")
 *   - opencodego.autocomplete.enable: Enable/disable (default: false)
 *   - opencodego.autocomplete.maxTokens: Max tokens per cycle (default: 512)
 *   - opencodego.autocomplete.debounceMs: Debounce delay (default: 300)
 *   - opencodego.autocomplete.maxLoopCycles: Max tool-use loop cycles (default: 3)
 *   - opencodego.autocomplete.useToolLoop: Use tool-use loop (default: true)
 *   - opencodego.autocomplete.reasoningEffort: Reasoning effort (default: "low")
 */

import * as vscode from "vscode";
import type { AutocompleteConfig, StreamSessionResult } from "./types";
import { DEFAULT_AUTOCOMPLETE_CONFIG } from "./types";
import { AutocompleteSession, SessionManager } from "./session";
import { streamSession } from "./streamer";
import { RequestThrottle, computeFingerprint, extractCodeContext, type ThrottleConfig } from "./throttle";

// ─── Provider ─────────────────────────────────────────────────────────────────

export class PersistentAutocompleteProvider implements vscode.InlineCompletionItemProvider {
  private _sessionManager: SessionManager;
  private _throttle: RequestThrottle;
  private _output: vscode.OutputChannel;
  private _enabled: boolean;
  private _config: AutocompleteConfig;

  /** Status bar item showing autocomplete state */
  private _statusBarItem: vscode.StatusBarItem | undefined;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    config?: Partial<AutocompleteConfig>,
  ) {
    this._output = outputChannel;
    this._config = { ...DEFAULT_AUTOCOMPLETE_CONFIG, ...config };
    this._enabled = vscode.workspace
      .getConfiguration("opencodego")
      .get("autocomplete.enable", false);

    this._sessionManager = new SessionManager(this._config);

    const throttleConfig: Partial<ThrottleConfig> = {
      debounceMs: this._config.debounceMs,
      minIntervalMs: 500,
      maxPending: 1,
    };
    this._throttle = new RequestThrottle(throttleConfig);

    // Status bar
    this._statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      93,
    );
    this._statusBarItem.text = "$(sparkle) Autocomplete";
    this._statusBarItem.tooltip = "Persistent Autocomplete (MiMo)";
    context.subscriptions.push(this._statusBarItem);

    // Listen for config changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("opencodego.autocomplete")) {
          this._reloadConfig();
        }
      }),
    );

    this._log(`Persistent autocomplete initialized (enabled=${this._enabled}, model=${this._config.modelId})`);
  }

  // ─── InlineCompletionItemProvider ─────────────────────────────────────────

  provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.InlineCompletionList> {
    if (!this._enabled) {
      return { items: [] };
    }

    // Skip if triggered by select (only respond to typing)
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      // Check if we're in a comment or string — skip autocomplete
      const lineText = document.lineAt(position.line).text;
      const trimmed = lineText.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) {
        return { items: [] };
      }
    }

    return this._provideCompletions(document, position, token);
  }

  // ─── Internal Implementation ──────────────────────────────────────────────

  private async _provideCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList> {
    const startTime = Date.now();

    try {
      // Compute fingerprint for deduplication
      const codeContext = extractCodeContext(
        { getText: () => document.getText(), lineCount: document.lineCount },
        position.line,
      );
      const fp = computeFingerprint(document.uri.toString(), position.line, position.character, codeContext);

      // Skip if same request is already pending
      if (this._throttle.shouldSkip(fp)) {
        this._log("Skipping duplicate request");
        return { items: [] };
      }

      // Cancel any pending request
      const controller = this._throttle.beginRequest(fp);

      // Update status bar
      this._updateStatusBar("loading");

      try {
        // Get or create session for this document
        const session = this._sessionManager.getOrCreate(document.uri.toString());

        this._log(
          `Starting completion (session=${session.id}, state=${session.state}, ` +
          `cache=${session.info.cacheWarmed}, requests=${session.info.requestCount})`,
        );

        // Run stream session with tool-use loop
        const result = await streamSession({
          url: this._config.gatewayUrl + "/chat/completions",
          apiKey: this._config.apiKey,
          config: this._config,
          messages: session.messages,
          codeContext,
          signal: controller.signal,
          output: this._output,
        });

        // Record the exchange in the session
        if (result.error) {
          this._log(`Stream error: ${result.error}`);
          this._updateStatusBar("error");
          return { items: [] };
        }

        if (result.cancelled) {
          this._log("Stream cancelled");
          this._updateStatusBar("idle");
          return { items: [] };
        }

        if (!result.accumulatedText) {
          this._log("Empty completion");
          this._updateStatusBar("idle");
          return { items: [] };
        }

        // Record in session for context retention
        session.recordExchange(
          codeContext,
          result.accumulatedText,
          result.hadToolCall
            ? [{ id: "tool-auto", name: "wait_for_input", arguments: '{"status":"ready"}' }]
            : undefined,
          undefined,
          result.totalTokens,
        );

        // Build completion item
        const item = new vscode.InlineCompletionItem(
          result.accumulatedText,
          new vscode.Range(position, position),
        );

        // Add command to show details on accept
        item.command = {
          command: "opencodego.autocompleteAccepted",
          title: "Autocomplete Accepted",
          arguments: [{ sessionId: session.id, text: result.accumulatedText }],
        };

        const elapsed = Date.now() - startTime;
        this._log(
          `Completion ready (${elapsed}ms, ${result.accumulatedText.length} chars, ` +
          `${result.cycles.length} cycles, ${result.totalTokens} tokens)`,
        );

        this._updateStatusBar("success");

        return { items: [item] };
      } finally {
        this._throttle.endRequest(controller);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._log(`Error: ${message}`);
      this._updateStatusBar("error");
      return { items: [] };
    }
  }

  // ─── Configuration ────────────────────────────────────────────────────────

  private _reloadConfig(): void {
    const cfg = vscode.workspace.getConfiguration("opencodego");
    this._enabled = cfg.get("autocomplete.enable", false);
    this._config = {
      ...this._config,
      modelId: cfg.get("autocomplete.model", DEFAULT_AUTOCOMPLETE_CONFIG.modelId),
      maxTokensPerCycle: cfg.get("autocomplete.maxTokens", DEFAULT_AUTOCOMPLETE_CONFIG.maxTokensPerCycle),
      debounceMs: cfg.get("autocomplete.debounceMs", DEFAULT_AUTOCOMPLETE_CONFIG.debounceMs),
      maxLoopCycles: cfg.get("autocomplete.maxLoopCycles", DEFAULT_AUTOCOMPLETE_CONFIG.maxLoopCycles),
      useToolLoop: cfg.get("autocomplete.useToolLoop", DEFAULT_AUTOCOMPLETE_CONFIG.useToolLoop),
      reasoningEffort: cfg.get("autocomplete.reasoningEffort", DEFAULT_AUTOCOMPLETE_CONFIG.reasoningEffort),
    };
    this._sessionManager.updateConfig(this._config);
    this._throttle.dispose();
    this._throttle = new RequestThrottle({
      debounceMs: this._config.debounceMs,
      minIntervalMs: 500,
      maxPending: 1,
    });
    this._log(`Config reloaded: model=${this._config.modelId}, toolLoop=${this._config.useToolLoop}`);
  }

  /**
   * Update the model used for autocomplete.
   */
  setModel(modelId: string): void {
    this._config.modelId = modelId;
    this._sessionManager.updateConfig({ modelId });
    this._log(`Model changed to ${modelId}`);
    // Destroy existing sessions since they use the old model
    this._sessionManager.destroyAll();
  }

  /**
   * Enable or disable the autocomplete provider.
   */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (!enabled) {
      this._sessionManager.destroyAll();
      this._throttle.dispose();
    }
    this._log(`Autocomplete ${enabled ? "enabled" : "disabled"}`);
  }

  // ─── Status Bar ───────────────────────────────────────────────────────────

  private _updateStatusBar(state: "idle" | "loading" | "success" | "error"): void {
    if (!this._statusBarItem) return;

    switch (state) {
      case "loading":
        this._statusBarItem.text = "$(sync~spin) Autocomplete";
        this._statusBarItem.tooltip = "Generating completion...";
        break;
      case "success":
        this._statusBarItem.text = "$(sparkle) Autocomplete";
        this._statusBarItem.tooltip = "Completion ready";
        // Auto-reset after 2s
        setTimeout(() => this._updateStatusBar("idle"), 2000);
        break;
      case "error":
        this._statusBarItem.text = "$(warning) Autocomplete";
        this._statusBarItem.tooltip = "Completion error";
        setTimeout(() => this._updateStatusBar("idle"), 3000);
        break;
      default:
        this._statusBarItem.text = "$(sparkle) Autocomplete";
        this._statusBarItem.tooltip = "Persistent Autocomplete (idle)";
    }
  }

  // ─── Logging ──────────────────────────────────────────────────────────────

  private _log(message: string): void {
    this._output.appendLine(`[persistent-ac] ${message}`);
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  dispose(): void {
    this._sessionManager.destroyAll();
    this._throttle.dispose();
    this._statusBarItem?.dispose();
  }
}
