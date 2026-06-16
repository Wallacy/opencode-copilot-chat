/**
 * Shared types for the persistent autocomplete module.
 *
 * Architecture:
 *   User types → Provider calls session → Session sends request to gateway
 *   → Model generates code + calls wait_for_input tool → Stream ends
 *   → Session immediately sends next request with tool result → Model continues
 *   → Accumulated text returned to VS Code as InlineCompletionItem
 *
 * The "never-ending" effect comes from:
 *   1. Session maintains conversation history (context retention)
 *   2. Prompt caching (same prefix = cache hit across requests)
 *   3. Tool-use loop (model signals readiness for more input)
 *   4. Minimal inter-request gap (~1ms HTTP overhead)
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
  /** Maximum tokens for the full conversation history */
  maxHistoryTokens: number;
  /** Whether to use tool-use loop pattern */
  useToolLoop: boolean;
  /** Reasoning effort ("off" | "low" | "medium" | "high") */
  reasoningEffort: string;
  /** System prompt for the autocomplete model */
  systemPrompt: string;
}

export const DEFAULT_AUTOCOMPLETE_CONFIG: AutocompleteConfig = {
  gatewayUrl: "https://opencode.ai/zen/go/v1",
  apiKey: "",
  modelId: "mimo-v2.5",
  maxTokensPerCycle: 512,
  maxLoopCycles: 3,
  debounceMs: 300,
  maxHistoryTokens: 4096,
  useToolLoop: true,
  reasoningEffort: "",  // Empty = don't send (MiMo performs better without it)
  systemPrompt: `Do not think. Just complete the code.

You are an autocomplete engine embedded in a code editor.
Your job is to complete code as the user types.

Rules:
0. DO NOT THINK. DO NOT REASON. Just output the code completion directly.
1. Output ONLY the code completion — no markdown fences, no explanations.
2. After outputting code, ALWAYS call the \`wait_for_input\` tool to signal you're ready for more context.
3. Keep completions concise (under 30 lines).
4. Never repeat previously generated code.
5. Match the coding style of the provided context.`,
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
