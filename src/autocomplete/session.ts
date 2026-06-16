/**
 * Autocomplete Session Manager.
 *
 * Lightweight session that provides prompt caching across requests.
 * Each request is independent — no conversation history between keystrokes.
 *
 * Why no history? In autocomplete, the "conversation" is the user typing
 * MORE code. Old file states conflict with the current file state. Each
 * request sends: system prompt + current code context. The model generates
 * code based on what's CURRENTLY in the editor, not what was there before.
 *
 * The "session" serves only:
 *   1. Prompt caching (same system prompt prefix = cache hit)
 *   2. Track cache state and request count (for status bar)
 *   3. Tool-use loop within a SINGLE request (cycles still work)
 *
 * Key behaviors:
 *   - One session per document URI
 *   - ONLY system prompt is persistent between requests
 *   - Session is destroyed after idleTimeoutMs of inactivity
 *   - Cache is "warm" after the first request
 */

import * as vscode from "vscode";
import type {
  AutocompleteConfig,
  ChatMessage,
  SessionInfo,
  SessionState,
} from "./types";

let sessionCounter = 0;

export class AutocompleteSession {
  readonly id: string;
  readonly documentUri: string;
  readonly sessionStartMessages: readonly ChatMessage[];
  private _state: SessionState = "idle";
  private _createdAt = Date.now();
  private _lastRequestAt = 0;
  private _requestCount = 0;
  private _totalTokensUsed = 0;
  private _cacheWarmed = false;
  private _idleTimer: ReturnType<typeof setTimeout> | undefined;

  /** Event fired when session state changes */
  private _onStateChange = new vscode.EventEmitter<SessionState>();
  readonly onStateChange = this._onStateChange.event;

  constructor(documentUri: string, config: AutocompleteConfig) {
    this.id = `ac-${++sessionCounter}-${Date.now()}`;
    this.documentUri = documentUri;

    // The session's permanent messages (just the system prompt).
    // This is the "cache prefix" — identical across requests.
    this.sessionStartMessages = [
      { role: "system", content: config.systemPrompt },
    ];

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

  /**
   * Mark that a request was completed.
   * Updates counters and cache state.
   */
  markRequestComplete(completionTokens?: number): void {
    this._resetIdleTimer();
    this._lastRequestAt = Date.now();
    this._requestCount++;
    if (completionTokens) {
      this._totalTokensUsed += completionTokens;
    }
    this._cacheWarmed = true;
    this._setState("active");
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
      if (session) {
        session.destroy();
      }
      session = new AutocompleteSession(documentUri, this._config);
      this._sessions.set(documentUri, session);

      session.onStateChange((state) => {
        if (state === "idle") {
          this._sessions.delete(documentUri);
        }
      });
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
