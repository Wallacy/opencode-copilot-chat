// test-reasoning.mts - quick test to see if MiMo produces output without reasoning_effort param
const key = process.env.OPENCODE_API_KEY;
if (!key) { console.error("Set OPENCODE_API_KEY"); process.exit(1); }

async function test() {
  const body = JSON.stringify({
    model: "mimo-v2.5",
    messages: [
      { role: "system", content: "Do not think. Just complete the code. Output ONLY the code. No markdown, no explanations." },
      { role: "user", content: "function fibon<CURSOR>" }
    ],
    max_tokens: 2048,
    stream: true,
    stream_options: { include_usage: true }
  });

  const res = await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body
  });

  let text = "", reasoning = "", cached = 0, completion = 0, prompt = 0, buf = "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const p = line.slice(6).trim();
      if (p === "[DONE]") continue;
      try {
        const d = JSON.parse(p);
        if (d.usage) { cached = d.usage.prompt_tokens_details?.cached_tokens ?? 0; completion = d.usage.completion_tokens ?? 0; prompt = d.usage.prompt_tokens ?? 0; }
        if (d.choices?.[0]?.delta?.content) text += d.choices[0].delta.content;
        if (d.choices?.[0]?.delta?.reasoning_content) reasoning += d.choices[0].delta.reasoning_content;
      } catch {}
    }
  }

  console.log(JSON.stringify({
    textLen: text.length,
    text: text.slice(0, 300),
    reasoningLen: reasoning.length,
    reasoning: reasoning.slice(0, 200),
    completionTokens: completion,
    cachedTokens: cached,
    promptTokens: prompt
  }, null, 2));
}

test().catch(e => console.error(e));
