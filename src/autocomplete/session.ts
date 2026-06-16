/**
 * Autocomplete Session Manager.
 *
 * Maintains conversation history across autocomplete requests, enabling
 * the "persistent session" pattern where the model retains context.
 *
 * Key behaviors:
 *   - One session per document URI
 *   - Conversation history grows with each request (user → assistant → tool)
 *   - History is trimmed when it exceeds maxHistoryTokens
 *   - Session is destroyed after idleTimeoutMs of inactivity
 *   - Cache is "warm" after the first request (system prompt prefix cached)
 */

import * as vscode from "vscode";
import type {
  AutocompleteConfig,
  ChatMessage,
  SessionInfo,
  SessionState,
} from "./types";
import { WAIT_FOR_INPUT_TOOL } from "./types";

let sessionCounter = 0;

export class AutocompleteSession {
  readonly id: string;
  readonly documentUri: string;
  private _state: SessionState = "idle";
  private _createdAt = Date.now();
  private _lastRequestAt = 0;
  private _requestCount = 0;
  private _totalTokensUsed = 0;
  private _cacheWarmed = false;
  private _messages: ChatMessage[] = [];
  private _idleTimer: ReturnType<typeof setTimeout> | undefined;
  private _config: AutocompleteConfig;

  /** Event fired when session state changes */
  private _onStateChange = new vscode.EventEmitter<SessionState>();
  readonly onStateChange = this._onStateChange.event;

  constructor(documentUri: string, config: AutocompleteConfig) {
    this.id = `ac-${++sessionCounter}-${Date.now()}`;
    this.documentUri = documentUri;
    this._config = config;

    // Initialize with system prompt
    this._messages.push({
      role: "system",
      content: config.systemPrompt,
    });

    this._setState("idle");
    this._resetIdleTimer();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  get state(): SessionState {
    return this._state;
  }

  get info(): SessionInfo {
    return {
      id: this.id,
      documentUri: this.documentUri,
      state: this._state,
      createdAt: this._createdAt,
      lastRequestAt: this._lastRequestAt,
      requestCount: this._requestCount,
      totalTokensUsed: this._totalTokensUsed,
      cacheWarmed: this._cacheWarmed,
    };
  }

  get messages(): readonly ChatMessage[] {
    return this._messages;
  }

  get config(): AutocompleteConfig {
    return this._config;
  }

  /**
   * Build the request payload for the next API call.
   * Includes the full conversation history (which enables cache hits
   * on the shared prefix).
   */
  buildRequestPayload(
    codeContext: string,
    includeTools: boolean,
  ): Record<string, unknown> {
    // Add the user message with code context
    const userMessage: ChatMessage = {
      role: "user",
      content: codeContext,
    };

    // We need to track this user message separately because we don't
    // add it to _messages until after the assistant responds.
    // For the API request, we include it at the end.
    const requestMessages = [...this._messages, userMessage];

    const body: Record<string, unknown> = {
      model: this._config.modelId,
      messages: requestMessages,
      max_tokens: this._config.maxTokensPerCycle,
      stream: true,
      stream_options: { include_usage: true },
    };

    // Add reasoning_effort if configured
    if (this._config.reasoningEffort && this._config.reasoningEffort !== "off") {
      body.reasoning_effort = this._config.reasoningEffort;
    }

    // Add tool definitions if using tool loop
    if (includeTools && this._config.useToolLoop) {
      body.tools = [WAIT_FOR_INPUT_TOOL];
      body.tool_choice = {
        type: "function",
        function: { name: "wait_for_input" },
      };
    }

    return body;
  }

  /**
   * Record the user message and assistant response in the conversation history.
   * Called after a successful stream cycle.
   */
  recordExchange(
    userContent: string,
    assistantContent: string,
    toolCalls?: Array<{ id: string; name: string; arguments: string }>,
    toolResult?: { toolCallId: string; content: string },
    completionTokens?: number,
  ): void {
    this._resetIdleTimer();
    this._lastRequestAt = Date.now();
    this._requestCount++;

    if (completionTokens) {
      this._totalTokensUsed += completionTokens;
    }

    // Add user message
    this._messages.push({
      role: "user",
      content: userContent,
    });

    // Add assistant message
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: assistantContent || "",
    };

    if (toolCalls && toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
    }

    this._messages.push(assistantMsg);

    // Add tool result if present
    if (toolResult) {
      this._messages.push({
        role: "tool",
        content: toolResult.content,
        tool_call_id: toolResult.toolCallId,
      });
    }

    // Trim history if it exceeds max tokens (approximate)
    this._trimHistory();

    // Mark cache as warm after first successful request
    this._cacheWarmed = true;
    this._setState("active");
  }

  /**
   * Record that the stream ended without a tool call (finish=length or stop).
   * We still add the user message but don't add a tool result.
   */
  recordNonToolExchange(userContent: string, assistantContent: string, completionTokens?: number): void {
    this.recordExchange(userContent, assistantContent, undefined, undefined, completionTokens);
  }

  /**
   * Destroy the session and clean up resources.
   */
  destroy(): void {
    this._setState("draining");
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = undefined;
    }
    this._messages = [];
    this._onStateChange.dispose();
    this._setState("idle");
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _setState(state: SessionState): void {
    if (this._state !== state) {
      this._state = state;
      this._onStateChange.fire(state);
    }
  }

  private _resetIdleTimer(): void {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
    }
    // Destroy session after 5 minutes of inactivity
    this._idleTimer = setTimeout(() => {
      this.destroy();
    }, 5 * 60 * 1000);
  }

  /**
   * Trim conversation history when it exceeds the token budget.
   * Keeps the system prompt and the most recent messages.
   */
  private _trimHistory(): void {
    // Approximate token count: ~4 chars per token
    const approxTokens = JSON.stringify(this._messages).length / 4;
    if (approxTokens <= this._config.maxHistoryTokens) {
      return;
    }

    // Keep system prompt (index 0) and remove oldest non-system messages
    // until we're under budget. We remove in pairs (user + assistant).
    while (this._messages.length > 1) {
      const currentTokens = JSON.stringify(this._messages).length / 4;
      if (currentTokens <= this._config.maxHistoryTokens * 0.8) {
        break;
      }
      // Remove the message after system prompt (index 1)
      // But skip if it's a tool result that follows an assistant message
      if (this._messages.length > 2 && this._messages[1].role === "tool") {
        // Remove tool result and the preceding assistant
        this._messages.splice(1, 2);
      } else {
        this._messages.splice(1, 1);
      }
    }
  }
}

/**
 * Manages autocomplete sessions across documents.
 * One session per document URI. Sessions are lazily created and
 * automatically destroyed after idle timeout.
 */
export class SessionManager {
  private _sessions = new Map<string, AutocompleteSession>();
  private _config: AutocompleteConfig;

  constructor(config: AutocompleteConfig) {
    this._config = config;
  }

  /**
   * Get or create a session for the given document URI.
   */
  getOrCreate(documentUri: string): AutocompleteSession {
    let session = this._sessions.get(documentUri);
    if (!session || session.state === "idle" || session.state === "draining") {
      // Create new session
      if (session) {
        session.destroy();
      }
      session = new AutocompleteSession(documentUri, this._config);
      this._sessions.set(documentUri, session);

      // Clean up when session is destroyed
      session.onStateChange((state) => {
        if (state === "idle") {
          this._sessions.delete(documentUri);
        }
      });
    }
    return session;
  }

  /**
   * Get the active session for a document (if any).
   */
  get(documentUri: string): AutocompleteSession | undefined {
    const session = this._sessions.get(documentUri);
    if (session && (session.state === "idle" || session.state === "draining")) {
      return undefined;
    }
    return session;
  }

  /**
   * Destroy all sessions.
   */
  destroyAll(): void {
    for (const session of this._sessions.values()) {
      session.destroy();
    }
    this._sessions.clear();
  }

  /**
   * Update configuration for all existing and future sessions.
   */
  updateConfig(config: Partial<AutocompleteConfig>): void {
    this._config = { ...this._config, ...config };
  }

  get config(): AutocompleteConfig {
    return this._config;
  }
}
