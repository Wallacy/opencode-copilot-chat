/**
 * Stream Accumulator for persistent autocomplete.
 *
 * Handles:
 *   - SSE stream parsing with proper buffer management
 *   - Text accumulation across multiple stream chunks
 *   - Tool call detection and accumulation
 *   - Reasoning content detection
 *   - Token usage extraction
 *   - Abort/cancel support with proper cleanup
 *   - Auth header building (supports /chat/completions, /messages, /google)
 *
 * This module uses AbortSignal for cancellation (no vscode.CancellationToken dependency).
 */

import * as vscode from "vscode";
import type {
  AutocompleteConfig,
  ChatMessage,
  StreamCycleResult,
  StreamSessionResult,
} from "./types";
import { buildOpenCodeGatewayAuthHeaders, type OpenCodeEndpointKind } from "../openCodeAuth";

// ─── SSE Parser ───────────────────────────────────────────────────────────────

interface ParsedSSE {
  data: unknown | null;
}

function parseSSELine(line: string): ParsedSSE {
  if (!line.startsWith("data: ")) {
    return { data: null };
  }
  const payload = line.slice(6).trim();
  if (payload === "[DONE]") {
    return { data: null };
  }
  try {
    return { data: JSON.parse(payload) };
  } catch {
    return { data: null };
  }
}

// ─── Stream Cycle ─────────────────────────────────────────────────────────────

interface CycleAccumulator {
  text: string;
  toolCalled: boolean;
  toolCallId: string;
  toolCallName: string;
  toolCallArgs: string;
  finishReason: string;
  hadReasoning: boolean;
  cachedTokens: number;
  promptTokens: number;
  completionTokens: number;
  firstByteAt: number | undefined;
  buffer: string;
}

function createAccumulator(): CycleAccumulator {
  return {
    text: "",
    toolCalled: false,
    toolCallId: "",
    toolCallName: "",
    toolCallArgs: "",
    finishReason: "",
    hadReasoning: false,
    cachedTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    firstByteAt: undefined,
    buffer: "",
  };
}

function processSSEChunk(acc: CycleAccumulator, data: unknown): void {
  const obj = data as Record<string, unknown>;
  const choices = obj.choices as Array<Record<string, unknown>> | undefined;
  if (!choices || choices.length === 0) return;

  const choice = choices[0];
  const delta = choice.delta as Record<string, unknown> | undefined;
  if (!delta) return;

  // Accumulate text content
  if (typeof delta.content === "string") {
    acc.text += delta.content;
  }

  // Detect reasoning content
  if (delta.reasoning_content) {
    acc.hadReasoning = true;
  }

  // Accumulate tool calls
  const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
  if (toolCalls) {
    for (const tc of toolCalls) {
      acc.toolCalled = true;
      if (typeof tc.id === "string" && tc.id) {
        acc.toolCallId = tc.id;
      }
      const fn = tc.function as Record<string, unknown> | undefined;
      if (fn) {
        if (typeof fn.name === "string") {
          acc.toolCallName = fn.name;
        }
        if (typeof fn.arguments === "string") {
          acc.toolCallArgs += fn.arguments;
        }
      }
    }
  }

  // Finish reason
  if (typeof choice.finish_reason === "string" && choice.finish_reason) {
    acc.finishReason = choice.finish_reason;
  }

  // Usage data (usually in the last chunk)
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (usage) {
    const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    if (promptDetails && typeof promptDetails.cached_tokens === "number") {
      acc.cachedTokens = promptDetails.cached_tokens;
    }
    if (typeof usage.prompt_tokens === "number") {
      acc.promptTokens = usage.prompt_tokens;
    }
    if (typeof usage.completion_tokens === "number") {
      acc.completionTokens = usage.completion_tokens;
    }
  }
}

// ─── Auth Headers ─────────────────────────────────────────────────────────────

function resolveAuthHeaders(
  gatewayUrl: string,
  apiKey: string,
): Record<string, string> {
  // Detect endpoint kind from URL
  let endpointKind: OpenCodeEndpointKind = "chat-completions";
  if (gatewayUrl.includes("/messages")) {
    endpointKind = "messages";
  } else if (gatewayUrl.includes("/google")) {
    endpointKind = "google";
  }

  return {
    ...buildOpenCodeGatewayAuthHeaders(endpointKind, apiKey),
    "Content-Type": "application/json",
    "User-Agent": "opencode-copilot-chat/autocomplete",
  };
}

// ─── Stream a Single Cycle ────────────────────────────────────────────────────

async function streamSingleCycle(
  url: string,
  body: Record<string, unknown>,
  authHeaders: Record<string, string>,
  signal: AbortSignal,
  onTextChunk?: (text: string) => void,
): Promise<StreamCycleResult> {
  const requestStartMs = Date.now();
  const acc = createAccumulator();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errBody = await response.text();
      return {
        text: "",
        toolCalled: false,
        toolCallId: null,
        toolCallName: null,
        toolCallArgs: null,
        finishReason: `http-${response.status}`,
        ttfbMs: Date.now() - requestStartMs,
        totalMs: Date.now() - requestStartMs,
        completionTokens: 0,
        cachedTokens: 0,
        promptTokens: 0,
        hadReasoning: false,
        statusCode: response.status,
      };
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      if (!acc.firstByteAt && value?.byteLength) {
        acc.firstByteAt = Date.now();
      }

      acc.buffer += decoder.decode(value, { stream: true });
      const lines = acc.buffer.split("\n");
      acc.buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const { data } = parseSSELine(trimmed);
        if (data) {
          processSSEChunk(acc, data);
          // Fire text chunk callback for real-time updates
          if (acc.text && onTextChunk) {
            onTextChunk(acc.text);
          }
        }
      }
    }

    // Process any remaining buffer
    if (acc.buffer.trim()) {
      const { data } = parseSSELine(acc.buffer.trim());
      if (data) {
        processSSEChunk(acc, data);
      }
    }

    const totalMs = Date.now() - requestStartMs;
    const ttfbMs = acc.firstByteAt ? acc.firstByteAt - requestStartMs : totalMs;

    return {
      text: acc.text,
      toolCalled: acc.toolCalled,
      toolCallId: acc.toolCallId || null,
      toolCallName: acc.toolCallName || null,
      toolCallArgs: acc.toolCallArgs || null,
      finishReason: acc.finishReason,
      ttfbMs,
      totalMs,
      completionTokens: acc.completionTokens,
      cachedTokens: acc.cachedTokens,
      promptTokens: acc.promptTokens,
      hadReasoning: acc.hadReasoning,
      statusCode: response.status,
    };
  } catch (err) {
    const totalMs = Date.now() - requestStartMs;
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: "",
      toolCalled: false,
      toolCallId: null,
      toolCallName: null,
      toolCallArgs: null,
      finishReason: `error: ${message}`,
      ttfbMs: 0,
      totalMs,
      completionTokens: 0,
      cachedTokens: 0,
      promptTokens: 0,
      hadReasoning: false,
      statusCode: 0,
    };
  }
}

// ─── Full Stream Session (Multiple Cycles) ────────────────────────────────────

export interface StreamSessionOptions {
  /** Gateway chat completions URL */
  url: string;
  /** API key */
  apiKey: string;
  /** Configuration */
  config: AutocompleteConfig;
  /** Current conversation messages (without the user message for this request) */
  messages: readonly ChatMessage[];
  /** Code context to send as user message */
  codeContext: string;
  /** Abort signal for cancellation */
  signal: AbortSignal;
  /** Callback for real-time text updates */
  onTextChunk?: (text: string) => void;
  /** Output channel for debugging */
  output?: vscode.OutputChannel;
}

/**
 * Run a full stream session with optional tool-use loop.
 *
 * Each cycle:
 *   1. Send request with conversation history + code context
 *   2. Model generates code + (optionally) calls wait_for_input
 *   3. If tool called: add tool result to history, send next request
 *   4. Repeat until max cycles reached or model stops calling tool
 *
 * Returns accumulated text from all cycles.
 */
export async function streamSession(
  options: StreamSessionOptions,
): Promise<StreamSessionResult> {
  const {
    url,
    apiKey,
    config,
    messages,
    codeContext,
    signal,
    onTextChunk,
    output,
  } = options;

  const authHeaders = resolveAuthHeaders(url, apiKey);
  const allCycles: StreamCycleResult[] = [];
  let accumulatedText = "";
  let totalMs = 0;
  let totalTokens = 0;
  let hadToolCall = false;
  let cancelled = false;
  let error: string | undefined;

  // Working copy of messages (we append user/assistant/tool messages as we go)
  const workingMessages: ChatMessage[] = [...messages];

  const maxCycles = config.useToolLoop ? config.maxLoopCycles : 1;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    if (signal.aborted) {
      cancelled = true;
      break;
    }

    const cycleStart = Date.now();

    // Build request payload
    const body: Record<string, unknown> = {
      model: config.modelId,
      messages: [...workingMessages, { role: "user", content: codeContext }],
      max_tokens: config.maxTokensPerCycle,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (config.reasoningEffort) {
      body.reasoning_effort = config.reasoningEffort;
    }

    if (config.useToolLoop) {
      body.tools = [
        {
          type: "function",
          function: {
            name: "wait_for_input",
            description: "Signal you're ready for more input. Always call this after outputting code.",
            parameters: {
              type: "object",
              properties: {
                status: {
                  type: "string",
                  enum: ["ready", "needs_context", "done"],
                },
              },
              required: ["status"],
            },
          },
        },
      ];
      body.tool_choice = {
        type: "function",
        function: { name: "wait_for_input" },
      };
    }

    output?.appendLine(
      `[autocomplete] cycle=${cycle + 1}/${maxCycles} model=${config.modelId} messages=${workingMessages.length + 1}`,
    );

    // Stream the cycle
    const cycleResult = await streamSingleCycle(
      url,
      body,
      authHeaders,
      signal,
      (text) => {
        // Fire incremental text updates for the current cycle
        if (onTextChunk) {
          onTextChunk(accumulatedText + text);
        }
      },
    );

    allCycles.push(cycleResult);
    accumulatedText += cycleResult.text;
    totalMs += cycleResult.totalMs;
    totalTokens += cycleResult.completionTokens;

    output?.appendLine(
      `[autocomplete] cycle=${cycle + 1} ttfb=${cycleResult.ttfbMs}ms total=${cycleResult.totalMs}ms ` +
      `tokens=${cycleResult.completionTokens} cached=${cycleResult.cachedTokens} ` +
      `tool=${cycleResult.toolCalled} finish=${cycleResult.finishReason} textLen=${cycleResult.text.length}`,
    );

    if (cycleResult.statusCode >= 400) {
      error = `HTTP ${cycleResult.statusCode}`;
      break;
    }

    if (signal.aborted) {
      cancelled = true;
      break;
    }

    // If model called the tool, continue the loop
    if (cycleResult.toolCalled && cycleResult.toolCallId) {
      hadToolCall = true;

      // Add user message to working history
      workingMessages.push({ role: "user", content: codeContext });

      // Add assistant message with tool call
      workingMessages.push({
        role: "assistant",
        content: cycleResult.text || "",
        tool_calls: [
          {
            id: cycleResult.toolCallId,
            type: "function",
            function: {
              name: cycleResult.toolCallName || "wait_for_input",
              arguments: cycleResult.toolCallArgs || '{"status":"ready"}',
            },
          },
        ],
      });

      // Add tool result
      workingMessages.push({
        role: "tool",
        tool_call_id: cycleResult.toolCallId,
        content: JSON.stringify({
          status: "ready",
          message: "User has typed more code. Continue the autocomplete.",
        }),
      });

      output?.appendLine(
        `[autocomplete] tool-loop: cycle ${cycle + 1} called tool, continuing...`,
      );
    } else {
      // No tool call — end the loop
      output?.appendLine(
        `[autocomplete] cycle ${cycle + 1} finished (finish=${cycleResult.finishReason}), stopping.`,
      );
      break;
    }
  }

  return {
    accumulatedText,
    cycles: allCycles,
    totalMs,
    totalTokens,
    hadToolCall,
    cancelled,
    error,
  };
}
