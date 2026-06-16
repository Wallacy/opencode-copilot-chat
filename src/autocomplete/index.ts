/**
 * Persistent Autocomplete Module — Public API.
 *
 * This module provides a VS Code InlineCompletionItemProvider that uses
 * a "persistent session" pattern with MiMo V2.5 (or any model) to maintain
 * context across autocomplete requests.
 *
 * Architecture:
 *   User stops typing → Provider snapshots code context → Stream runs request
 *   → Accumulated text returned to VS Code as an InlineCompletionItem
 *   → Lightweight per-document session tracks cache/request metadata
 *
 * Key features:
 *   - Prompt-cache-friendly stable system message
 *   - Optional experimental tool-use loop
 *   - Debounce/cancellation for rapid typing
 *   - Model selection: User can choose any model (default: mimo-v2.5)
 *
 * Activation:
 *   1. Enable in settings: "opencodego.autocomplete.enable": true
 *   2. Set API key: OpenCode Go: Set API Key
 *   3. Optional: Configure model, debounce, etc.
 *
 * Configuration (in settings.json):
 *   "opencodego.autocomplete.enable": true,
 *   "opencodego.autocomplete.model": "mimo-v2.5",
 *   "opencodego.autocomplete.maxTokens": 2048,
 *   "opencodego.autocomplete.debounceMs": 300,
 *   "opencodego.autocomplete.maxLoopCycles": 2,
 *   "opencodego.autocomplete.useToolLoop": false
 */

export { PersistentAutocompleteProvider } from "./provider";
export { AutocompleteSession, SessionManager } from "./session";
export { streamSession, type StreamSessionOptions } from "./streamer";
export { RequestThrottle, computeFingerprint, extractCodeContext } from "./throttle";
export type {
  AutocompleteConfig,
  SessionInfo,
  SessionState,
  StreamCycleResult,
  StreamSessionResult,
  ChatMessage,
} from "./types";
export { DEFAULT_AUTOCOMPLETE_CONFIG, WAIT_FOR_INPUT_TOOL } from "./types";
