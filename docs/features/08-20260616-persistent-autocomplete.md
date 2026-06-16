# Persistent Autocomplete

**Feature**: LLM-powered inline completions with session-based context retention  
**Status**: Experimental (opt-in)  
**Added**: 2026-06-16  

## Overview

Persistent autocomplete provides AI-powered inline code completions using the same OpenCode Go models available in Copilot Chat. It registers a VS Code `InlineCompletionItemProvider` and returns ghost text directly to the editor.

## How It Works

```
User stops typing → VS Code calls provider → Provider waits debounce
→ Current file context is sent to OpenCode Go → Model streams code
→ Provider returns an InlineCompletionItem → VS Code renders ghost text
```

### Key Components

| Component | Purpose |
|---|---|
| `session.ts` | Tracks one lightweight session per document for request counts and prompt-cache-friendly system messages. |
| `streamer.ts` | SSE stream parser. Accumulates streamed text and optionally handles the experimental tool loop. |
| `throttle.ts` | Legacy helper kept exported for experiments; provider now relies on VS Code cancellation plus debounce. |
| `provider.ts` | VS Code `InlineCompletionItemProvider`. Reads API key from `context.secrets` and returns the actual ghost text promise. |

### Tool-Use Loop

The optional tool loop lets the model call a `wait_for_input` tool after a completion. This can allow multiple generation cycles per request, but it increases latency and is disabled by default.

1. Cycle 1: Model generates code → calls `wait_for_input` → tool result sent back
2. Cycle 2: Model continues from where it left off → calls `wait_for_input` or stops
3. Repeat up to `maxLoopCycles` times

If the model doesn't call the tool (finish=stop or finish=length), the loop ends.

## Configuration

All settings are under `opencodego.autocomplete.*`.

| Setting | Default | Description |
|---|---|---|
| `enable` | `false` | Enable/disable the feature |
| `model` | `mimo-v2.5` | Model ID (OpenCode Go models only) |
| `maxTokens` | `2048` | Max tokens per completion cycle |
| `debounceMs` | `300` | Debounce delay (VS Code also has built-in debounce) |
| `useToolLoop` | `false` | Enable the experimental tool-use loop |
| `maxLoopCycles` | `2` | Max tool-use loop cycles per request when enabled |
| `maxInputTokens` | `4096` | Max input tokens (system prompt + history) to control cost |

## Copilot Inline Suggestions

Keep VS Code's global `editor.inlineSuggest.enabled` setting enabled. Turning it off disables the editor feature that renders all ghost text, including this provider.

If GitHub Copilot's own completions conflict, disable Copilot completions through the GitHub Copilot extension settings rather than disabling VS Code inline suggestions globally.

## Architecture

```
src/autocomplete/
├── types.ts        — Shared types + default config
├── session.ts      — Session manager (history + cache)
├── streamer.ts     — SSE stream parser + tool-use loop
├── throttle.ts     — Request deduplication
├── provider.ts     — VS Code InlineCompletionItemProvider
└── index.ts        — Public API
```

## Known Limitations

1. **Latency**: First request takes ~2-5s (cold start). Subsequent requests benefit from prompt caching (~1-2s faster).
2. **Reasoning overhead**: MiMo V2.5 always performs internal reasoning, consuming tokens before generating visible code. This is inherent to the model.
3. **Tool call rate**: MiMo doesn't always call the `wait_for_input` tool, which limits the effectiveness of the loop pattern.
4. **Single document**: Each document gets its own lightweight session. Sessions are destroyed after 5 minutes of inactivity.
5. **No character-by-character ghost text**: VS Code shows the inline item after the provider resolves.

## Testing

```bash
# E2E test (requires OPENCODE_API_KEY)
$env:OPENCODE_API_KEY = 'your-key'
npx tsx scripts/test-persistent-ac-e2e.mts

# Neverending stream investigation
npx tsx scripts/test-neverending-stream.mts
```
