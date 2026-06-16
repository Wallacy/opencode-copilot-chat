/**
 * Persistent Autocomplete Module — Public API.
 *
 * This module provides a VS Code InlineCompletionItemProvider that uses
 * a "persistent session" pattern with MiMo V2.5 (or any model) to maintain
 * context across autocomplete requests.
 *
 * Architecture:
 *   User types → Provider extracts code context → Session maintains history
 *   → Stream runs tool-use loop → Model generates code + calls wait_for_input
 *   → Accumulated text returned to VS Code → Session stays alive for next request
 *
 * Key features:
 *   - Context retention: Model remembers previous completions
 *   - Prompt caching: System prompt cached across requests (~512 tokens)
 *   - Tool-use loop: Model signals readiness for more input
 *   - Debounce: Prevents flooding API during rapid typing
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
 *   "opencodego.autocomplete.maxTokens": 512,
 *   "opencodego.autocomplete.debounceMs": 300,
 *   "opencodego.autocomplete.maxLoopCycles": 3,
 *   "opencodego.autocomplete.useToolLoop": true,
 *   "opencodego.autocomplete.reasoningEffort": "low"
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
