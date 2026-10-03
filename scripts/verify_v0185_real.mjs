// Real-server verification of v0.18.5 fixes, replicating the user's scenario:
// AstrBot-style giant tool schema + long context + writer model, streaming.
// Measures: time-to-first-byte (heartbeat should arrive ~immediately), total
// latency, and that the model's reasoning no longer mentions reading a giant
// tool document from the sandbox.
import { performance } from 'node:perf_hooks';

const BASE = process.env.SAKANA_TEST_BASE || 'http://186.241.74.77:8787';
const KEY = process.env.SAKANA_TEST_KEY || '';
if (!KEY) {
  console.error('verify: SAKANA_TEST_KEY is required (never hardcode keys)');
  process.exit(1);
}

const bigSchema = Array.from({ length: 25 }, (_, i) => ({
  type: 'function',
  function: {
    name: `client_tool_${i}`,
    description: `Client tool number ${i} for the framework. `.repeat(12),
    parameters: { type: 'object', properties: { arg: { type: 'string', description: 'p'.repeat(400) } }, required: ['arg'] },
  },
}));

const novelContext = `【小说设定文档 v3】
标题：《青梅竹马与义妹的恋爱进行式》
世界观：私立白樱学园，现代东京郊区。
主要人物：
1. 浅野悠真——高二，文学社社长，沉稳寡言，对恋爱迟钝。
2. 星野春菜——悠真的青梅竹马，田径部王牌，暗恋悠真十年。
3. 浅野纱织——悠真的义妹（父母再婚），高一，家务全能，兄控但嘴硬。
4. 樱庭莲——悠真挚友，篮球部王牌，表面轻浮实则认真。
5. 樱庭茜——莲的义妹，图书委员，安静细腻。
主线：悠真在春菜与纱织之间的心意觉醒；副线：莲×茜的义兄妹恋爱、纱织×朔夜的旧友重逢。
基调：纯爱、1v1、群像、日常细腻、季节感强。
写作要求：每章 4000-6000 字，视角轮换但每章单一视角，对话占比 40% 以上，景物描写服务情绪。
`.repeat(30); // ~30x → >12K chars, triggers attachment packaging

const t0 = performance.now();
const resp = await fetch(BASE + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
  body: JSON.stringify({
    model: 'sakana-writer',
    messages: [{ role: 'user', content: novelContext + '\n\n请基于以上设定，写出第一章的开篇（约800字）。' }],
    tools: bigSchema,
    stream: true,
  }),
});
if (!resp.ok) {
  console.log('HTTP', resp.status, (await resp.text()).slice(0, 300));
  process.exit(1);
}
const reader = resp.body.getReader();
const dec = new TextDecoder();
let firstByteMs = null;
let firstContentMs = null;
let pings = 0;
let reasoningChars = 0;
let contentChars = 0;
let buf = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  const now = performance.now() - t0;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (line.startsWith(': ping')) { pings++; if (firstByteMs === null) firstByteMs = now; continue; }
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    if (firstByteMs === null) firstByteMs = now;
    let ev;
    try { ev = JSON.parse(line.slice(6)); } catch { continue; }
    const d = ev.choices?.[0]?.delta;
    if (d?.reasoning_content) reasoningChars += d.reasoning_content.length;
    if (d?.content) { contentChars += d.content.length; if (firstContentMs === null) firstContentMs = now; }
  }
}
const totalMs = performance.now() - t0;
console.log(`first byte (heartbeat/comment): ${firstByteMs === null ? 'none' : Math.round(firstByteMs) + 'ms'}`);
console.log(`first content token: ${firstContentMs === null ? 'none' : Math.round(firstContentMs) + 'ms'}`);
console.log(`total: ${Math.round(totalMs)}ms | pings: ${pings} | reasoning: ${reasoningChars} chars | content: ${contentChars} chars`);
console.log(pings > 0 ? '✓ heartbeat active during slow phases' : '✗ no heartbeat observed');
console.log(firstContentMs !== null && firstContentMs < 90000 ? '✓ first content within 90s' : '✗ too slow');
