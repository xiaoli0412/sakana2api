const BASE = 'http://127.0.0.1:8787';
console.log('=== TEST 2: streaming, thinking, web search ===');
const resp = await fetch(BASE + '/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'sakana-namazu',
    stream: true,
    thinking: true,
    web_search: true,
    messages: [{ role: 'user', content: '搜索一下今天2026年8月13日的新闻标题,用中文列3条' }],
  }),
});
console.log('status:', resp.status, 'ct:', resp.headers.get('content-type'));
const reader = resp.body.getReader();
const dec = new TextDecoder();
let buf = '', count = 0;
const kinds = { reasoning: 0, content: 0, tool: 0, finish: 0 };
let reasoningSample = '', contentSample = '', toolSample = '';
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    const m = /^data: (.*)$/.exec(line.trim());
    if (!m) continue;
    const d = m[1];
    if (d === '[DONE]') { kinds.finish++; continue; }
    let j; try { j = JSON.parse(d); } catch { continue; }
    const delta = j.choices?.[0]?.delta || {};
    count++;
    if (delta.reasoning_content) { kinds.reasoning += delta.reasoning_content.length; if (!reasoningSample) reasoningSample = delta.reasoning_content.slice(0, 40); }
    if (delta.content) { kinds.content += delta.content.length; if (!contentSample) contentSample = delta.content.slice(0, 40); }
    if (delta.tool_calls) { kinds.tool++; toolSample = JSON.stringify(delta.tool_calls[0].function).slice(0, 100); }
    if (j.choices?.[0]?.finish_reason) kinds.finish++;
  }
}
console.log('chunks:', count, 'of which by kind:', JSON.stringify(kinds));
console.log('reasoning sample:', JSON.stringify(reasoningSample));
console.log('content sample:', JSON.stringify(contentSample));
console.log('tool sample:', JSON.stringify(toolSample));
