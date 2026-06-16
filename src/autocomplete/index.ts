/**
 * Persistent Autocomplete Module — Public API.
 *
 * Lightweight module providing MiMo V2.5-powered inline completions.
 * Optimized for cost: ~200 prompt tokens + ~300 output tokens per request
 * (~$0.0001-0.00015 at MiMo V2.5 pricing).
 *
 * Activation: "opencodego.autocomplete.enable": true
 */

export { PersistentAutocompleteProvider } from "./provider";
export { AutocompleteSession, SessionManager } from "./session";
export { streamSession, type StreamSessionOptions } from "./streamer";
export type {
  AutocompleteConfig,
  SessionInfo,
  SessionState,
  StreamCycleResult,
  StreamSessionResult,
  ChatMessage,
} from "./types";
export { DEFAULT_AUTOCOMPLETE_CONFIG } from "./types";
