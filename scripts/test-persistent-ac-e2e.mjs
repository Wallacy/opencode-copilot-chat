#!/usr/bin/env npx tsx
/**
 * test-persistent-ac-e2e.mts
 *
 * End-to-end test for the persistent autocomplete implementation.
 * Tests the actual streamSession function with MiMo V2.5 via the OpenCode gateway.
 *
 * Tests:
 *   1. Single-shot completion (no tool loop)
 *   2. Tool-use loop (2 cycles)
 *   3. Session context retention (2 sequential requests)
 *   4. Cancellation handling
 *   5. Error handling (invalid model)
 */
const GATEWAY = process.env.OPENCODE_GATEWAY ?? "https://opencode.ai/zen/go/v1";
const API_KEY = process.env.OPENCODE_API_KEY ?? "";
const MODEL = process.env.OPENCODE_MODEL ?? "mimo-v2.5";
// ─── Minimal reimplementation of streamSession for standalone testing ─────────
// (We can't import from src/autocomplete/ directly due to VS Code dependency,
//  so we reimplement the core logic here)
const SYSTEM_PROMPT = `Do not think. Just complete the code.

You are an autocomplete engine embedded in a code editor.
Your job is to complete code as the user types.

Rules:
0. DO NOT THINK. DO NOT REASON. Just output the code completion directly.
1. Output ONLY the code completion — no markdown fences, no explanations.
2. After outputting code, ALWAYS call the \`wait_for_input\` tool to signal you're ready for more context.
3. Keep completions concise (under 30 lines).
4. Never repeat previously generated code.
5. Match the coding style of the provided context.`;
const WAIT_FOR_INPUT_TOOL = {
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
};
function authHeaders() {
    return {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "opencode-copilot-chat/test-e2e",
    };
}
function parseSSE(line) {
    if (!line.startsWith("data: "))
        return null;
    const p = line.slice(6).trim();
    if (p === "[DONE]")
        return null;
    try {
        return JSON.parse(p);
    }
    catch {
        return null;
    }
}
async function streamCycle(messages, maxTokens, useTools, signal) {
    const start = Date.now();
    let firstByte;
    let text = "", toolCallId = "", toolCallName = "", toolCallArgs = "";
    let toolCalled = false, finishReason = "";
    let cachedTokens = 0, promptTokens = 0, completionTokens = 0, hadReasoning = false;
    let buffer = "";
    const body = {
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        // Don't set reasoning_effort — let the model use defaults
        // (setting "low" actually increases reasoning overhead for MiMo)
    };
    if (useTools) {
        body.tools = [WAIT_FOR_INPUT_TOOL];
        body.tool_choice = { type: "function", function: { name: "wait_for_input" } };
    }
    const res = await fetch(`${GATEWAY}/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`HTTP ${res.status}: ${err.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
        const { value, done } = await reader.read();
        if (done)
            break;
        if (!firstByte && value?.byteLength)
            firstByte = Date.now();
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            const data = parseSSE(line.trim());
            if (!data)
                continue;
            const ch = data.choices?.[0];
            if (ch) {
                finishReason = ch.finish_reason ?? finishReason;
                if (ch.delta?.content)
                    text += ch.delta.content;
                if (ch.delta?.reasoning_content)
                    hadReasoning = true;
                if (ch.delta?.tool_calls) {
                    toolCalled = true;
                    for (const tc of ch.delta.tool_calls) {
                        if (tc.id)
                            toolCallId = tc.id;
                        if (tc.function?.name)
                            toolCallName = tc.function.name;
                        if (tc.function?.arguments)
                            toolCallArgs += tc.function.arguments;
                    }
                }
            }
            const u = data.usage;
            if (u) {
                cachedTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
                promptTokens = u.prompt_tokens ?? 0;
                completionTokens = u.completion_tokens ?? 0;
            }
        }
    }
    return {
        text, toolCalled, toolCallId: toolCallId || null,
        toolCallName: toolCallName || null, toolCallArgs: toolCallArgs || null,
        finishReason, ttfbMs: firstByte ? firstByte - start : Date.now() - start,
        totalMs: Date.now() - start, completionTokens, cachedTokens, promptTokens, hadReasoning,
    };
}
// ─── Test Scenarios ───────────────────────────────────────────────────────────
const REACT_HOOK = `import { useState, useEffect } from "react";

export function useFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(url)
      .then(res => res.json())
      .then(json => {`;
const EXPRESS_ROUTE = `import express from "express";

const router = express.Router();

router.get("/api/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const user = await db.users.findById(id);

    if (!user) {
      return res.status(404).json({`;
// ─── Test Runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(condition, message) {
    if (condition) {
        console.log(`  ✅ ${message}`);
        passed++;
    }
    else {
        console.log(`  ❌ ${message}`);
        failed++;
    }
}
async function test1_SingleShot() {
    console.log("\n╔═══════════════════════════════════════════════════════╗");
    console.log("║  Test 1: Single-shot completion (no tool loop)       ║");
    console.log("╚═══════════════════════════════════════════════════════╝\n");
    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: REACT_HOOK },
    ];
    const result = await streamCycle(messages, 1024, false);
    console.log(`  TTFB: ${result.ttfbMs}ms`);
    console.log(`  Total: ${result.totalMs}ms`);
    console.log(`  Tokens: ${result.completionTokens} (cached: ${result.cachedTokens}, prompt: ${result.promptTokens})`);
    console.log(`  Text (${result.text.length}ch): "${result.text.slice(0, 100)}..."`);
    console.log(`  Reasoning: ${result.hadReasoning}`);
    console.log(`  Finish: ${result.finishReason}`);
    assert(result.totalMs > 0, "Request completed");
    assert(result.text.length > 0, "Generated text");
    assert(result.completionTokens > 0, "Has completion tokens");
    assert(result.promptTokens > 0, "Has prompt tokens");
}
async function test2_ToolLoop() {
    console.log("\n╔═══════════════════════════════════════════════════════╗");
    console.log("║  Test 2: Tool-use loop (2 cycles)                    ║");
    console.log("╚═══════════════════════════════════════════════════════╝\n");
    let messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: REACT_HOOK },
    ];
    let totalText = "";
    let cycleCount = 0;
    for (let i = 0; i < 2; i++) {
        const result = await streamCycle(messages, 1024, true);
        cycleCount++;
        totalText += result.text;
        console.log(`  Cycle ${i + 1}: TTFB=${result.ttfbMs}ms total=${result.totalMs}ms tool=${result.toolCalled} text=${result.text.length}ch reasoning=${result.hadReasoning} finish=${result.finishReason}`);
        if (result.toolCalled && result.toolCallId) {
            // Add assistant message with tool call
            messages.push({
                role: "assistant",
                content: result.text || "",
                tool_calls: [{
                        id: result.toolCallId,
                        type: "function",
                        function: {
                            name: result.toolCallName || "wait_for_input",
                            arguments: result.toolCallArgs || '{"status":"ready"}',
                        },
                    }],
            });
            // Add tool result
            messages.push({
                role: "tool",
                tool_call_id: result.toolCallId,
                content: JSON.stringify({ status: "ready", message: "Continue autocomplete." }),
            });
        }
        else {
            console.log(`  No tool call (finish=${result.finishReason}), stopping loop.`);
            break;
        }
    }
    console.log(`  Total text: ${totalText.length}ch across ${cycleCount} cycles`);
    assert(cycleCount >= 1, "At least 1 cycle completed");
    assert(totalText.length > 0, "Generated text across cycles");
}
async function test3_SessionRetention() {
    console.log("\n╔═══════════════════════════════════════════════════════╗");
    console.log("║  Test 3: Session context retention (2 requests)      ║");
    console.log("╚═══════════════════════════════════════════════════════╝\n");
    // First request
    let messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: REACT_HOOK },
    ];
    const r1 = await streamCycle(messages, 1024, false);
    console.log(`  Request 1: TTFB=${r1.ttfbMs}ms total=${r1.totalMs}ms cached=${r1.cachedTokens} tokens=${r1.promptTokens}`);
    console.log(`  Text (${r1.text.length}ch): "${r1.text.slice(0, 80)}..."`);
    // Simulate session: add user + assistant to history
    messages.push({ role: "user", content: REACT_HOOK });
    messages.push({ role: "assistant", content: r1.text });
    // Second request (same prefix = cache hit)
    const r2 = await streamCycle(messages, 1024, false);
    console.log(`  Request 2: TTFB=${r2.ttfbMs}ms total=${r2.totalMs}ms cached=${r2.cachedTokens} tokens=${r2.promptTokens}`);
    console.log(`  Text (${r2.text.length}ch): "${r2.text.slice(0, 80)}..."`);
    assert(r1.totalMs > 0, "First request completed");
    assert(r2.totalMs > 0, "Second request completed");
    assert(r2.cachedTokens > r1.cachedTokens, `Cache improved: ${r1.cachedTokens} → ${r2.cachedTokens} cached tokens`);
}
async function test4_Cancellation() {
    console.log("\n╔═══════════════════════════════════════════════════════╗");
    console.log("║  Test 4: Cancellation handling                       ║");
    console.log("╚═══════════════════════════════════════════════════════╝\n");
    const controller = new AbortController();
    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: REACT_HOOK },
    ];
    // Cancel after 100ms
    setTimeout(() => controller.abort(), 100);
    try {
        await streamCycle(messages, 2048, false, controller.signal);
        assert(false, "Should have thrown on cancellation");
    }
    catch (err) {
        const isAbort = err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"));
        assert(isAbort, `Correctly threw on cancellation: ${err instanceof Error ? err.message : err}`);
    }
}
async function test5_ErrorHandling() {
    console.log("\n╔═══════════════════════════════════════════════════════╗");
    console.log("║  Test 5: Error handling (invalid API key)            ║");
    console.log("╚═══════════════════════════════════════════════════════╝\n");
    // Temporarily override auth
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        if (typeof url === "string" && url.includes("chat/completions")) {
            return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
                status: 401,
                headers: { "Content-Type": "application/json" },
            });
        }
        return origFetch(url, opts);
    };
    try {
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: REACT_HOOK },
        ];
        await streamCycle(messages, 256, false);
        assert(false, "Should have thrown on 401");
    }
    catch (err) {
        assert(err instanceof Error && err.message.includes("401"), `Correctly threw on 401: ${err instanceof Error ? err.message : err}`);
    }
    finally {
        globalThis.fetch = origFetch;
    }
}
// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    if (!API_KEY) {
        console.error("❌ Set OPENCODE_API_KEY environment variable");
        process.exit(1);
    }
    console.log("╔═══════════════════════════════════════════════════════╗");
    console.log("║  Persistent Autocomplete E2E Test                    ║");
    console.log("╠═══════════════════════════════════════════════════════╣");
    console.log(`║  Model:   ${MODEL.padEnd(42)}║`);
    console.log(`║  Gateway: ${GATEWAY.padEnd(42)}║`);
    console.log("╚═══════════════════════════════════════════════════════╝");
    await test1_SingleShot();
    await test2_ToolLoop();
    await test3_SessionRetention();
    await test4_Cancellation();
    await test5_ErrorHandling();
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log("═══════════════════════════════════════════════════════════");
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
export {};
//# sourceMappingURL=test-persistent-ac-e2e.mjs.map