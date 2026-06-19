/**
 * Shared types for the persistent autocomplete module.
 *
 * Architecture:
 *   User stops typing -> Provider snapshots current code context
 *   -> Streamer sends a chat-completions request to the gateway
 *   -> Accumulated text returns to VS Code as an InlineCompletionItem.
 *
 * Sessions are intentionally lightweight for autocomplete: the system prompt is
 * stable for prompt caching, while each request sends the current editor state.
 */

// ─── Configuration ────────────────────────────────────────────────────────────

export interface AutocompleteConfig {
  /** Gateway base URL (e.g., https://opencode.ai/zen/go/v1) */
  gatewayUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Model ID (e.g., "mimo-v2.5", "deepseek-v4-flash") */
  modelId: string;
  /** Maximum tokens per completion cycle */
  maxTokensPerCycle: number;
  /** Maximum number of tool-use loop cycles per provider call */
  maxLoopCycles: number;
  /** Debounce delay in ms (user stops typing → send request) */
  debounceMs: number;
  /** Whether to use tool-use loop pattern */
  useToolLoop: boolean;
  /** Maximum input tokens (system prompt + context) to control cost */
  maxInputTokens: number;
  /** System prompt for the autocomplete model */
  systemPrompt: string;
  /** Number of lines after cursor to include as context */
  suffixLines: number;
}

export const DEFAULT_AUTOCOMPLETE_CONFIG: AutocompleteConfig = {
  gatewayUrl: "https://opencode.ai/zen/go/v1",
  apiKey: "",
  modelId: "deepseek-v4-flash",
  maxTokensPerCycle: 8192,
  maxLoopCycles: 1,
  debounceMs: 800,
  useToolLoop: false,
  maxInputTokens: 512,
  systemPrompt: `You are a code completion engine. Do not think. You receive code before and after the cursor. Generate ONLY the code to insert at the cursor position. Do NOT repeat or rewrite existing code. Output ONLY the missing code. No markdown fences, no explanations.`,
  /** Code lines shown after the cursor for context (closing braces, etc.) */
  suffixLines: 10,
};

// ─── Session State ────────────────────────────────────────────────────────────

export type SessionState =
  | "idle"        // No active session
  | "warming"     // First request in progress (no cache)
  | "active"      // Session is warm, tool-use loop running
  | "draining"    // Session is being torn down
  | "error";      // Session encountered an error

export interface SessionInfo {
  /** Unique session ID */
  id: string;
  /** Document URI this session is for */
  documentUri: string;
  /** Current session state */
  state: SessionState;
  /** When the session was created */
  createdAt: number;
  /** When the last request was sent */
  lastRequestAt: number;
  /** Number of requests made in this session */
  requestCount: number;
  /** Total tokens consumed */
  totalTokensUsed: number;
  /** Whether the cache is warm */
  cacheWarmed: boolean;
}

// ─── Stream Result ────────────────────────────────────────────────────────────

export interface StreamCycleResult {
  /** Text generated in this cycle */
  text: string;
  /** Whether the model called the wait_for_input tool */
  toolCalled: boolean;
  /** Tool call ID (if tool was called) */
  toolCallId: string | null;
  /** Tool call name (if tool was called) */
  toolCallName: string | null;
  /** Tool call arguments (if tool was called) */
  toolCallArgs: string | null;
  /** Finish reason from the API */
  finishReason: string;
  /** Time to first byte in ms */
  ttfbMs: number;
  /** Total cycle time in ms */
  totalMs: number;
  /** Number of completion tokens generated */
  completionTokens: number;
  /** Number of cached prompt tokens */
  cachedTokens: number;
  /** Total prompt tokens */
  promptTokens: number;
  /** Whether reasoning content was detected */
  hadReasoning: boolean;
  /** Approximate number of reasoning characters streamed by the provider */
  reasoningChars: number;
  /** HTTP status code */
  statusCode: number;
}

export interface StreamSessionResult {
  /** All text accumulated across all cycles */
  accumulatedText: string;
  /** Results from each cycle */
  cycles: StreamCycleResult[];
  /** Total time for the entire stream session */
  totalMs: number;
  /** Total tokens generated across all cycles */
  totalTokens: number;
  /** Whether any cycle had a tool call */
  hadToolCall: boolean;
  /** Whether the session was cancelled */
  cancelled: boolean;
  /** Error message (if any) */
  error?: string;
}

// ─── Message Types ────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const WAIT_FOR_INPUT_TOOL = {
  type: "function" as const,
  function: {
    name: "wait_for_input",
    description:
      "Signal that you've completed the current autocomplete and are waiting for more user input. Always call this after outputting code.",
    parameters: {
      type: "object" as const,
      properties: {
        status: {
          type: "string" as const,
          enum: ["ready", "needs_context", "done"],
          description:
            "Current status: ready for more input, needs more context, or done.",
        },
      },
      required: ["status"],
    },
  },
};
