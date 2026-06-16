// test-models.mts - test both MiMo and DeepSeek with "Do not think" prompt + no reasoning_effort
const key = process.env.OPENCODE_API_KEY;
if (!key) { console.error("Set OPENCODE_API_KEY"); process.exit(1); }

async function testModel(modelId: string, label: string) {
  console.log(`\n=== ${label} (${modelId}) ===`);
  
  const body = JSON.stringify({
    model: modelId,
    messages: [
      { role: "system", content: "Do not think. Just complete the code. Output ONLY the code. No markdown, no explanations." },
      { role: "user", content: "function fibonacci(n: number): number {\n  if (n <CURSOR>" }
    ],
    max_tokens: 2048,
    stream: true,
    stream_options: { include_usage: true }
  });

  const start = Date.now();
  const res = await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body
  });

  let text = "", reasoning = "", cached = 0, completion = 0, prompt = 0, buf = "", firstByte: number | undefined;
  const reader = res.body.getReader();
  const dec = new TextDecoder();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!firstByte && value?.byteLength) firstByte = Date.now();
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

  const totalMs = Date.now() - start;
  const ttfbMs = firstByte ? firstByte - start : totalMs;
  const cost = (prompt / 1_000_000 * 0.14) + (completion / 1_000_000 * 0.28);
  
  console.log(`  TTFB: ${ttfbMs}ms  Total: ${totalMs}ms`);
  console.log(`  Prompt tokens: ${prompt} (cached: ${cached})`);
  console.log(`  Completion tokens: ${completion}`);
  console.log(`  Est. cost: $${cost.toFixed(6)}`);
  console.log(`  Reasoning chars: ${reasoning.length}`);
  console.log(`  Text chars: ${text.length}`);
  console.log(`  Text: "${text.slice(0, 250)}"`);
  console.log(`  Reasoning preview: "${reasoning.slice(0, 200)}"`);
}

async function main() {
  await testModel("mimo-v2.5", "MiMo V2.5");
  await testModel("deepseek-v4-flash", "DeepSeek V4 Flash");
}

main().catch(e => console.error(e));
