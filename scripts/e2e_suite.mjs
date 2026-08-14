const BASE = 'http://127.0.0.1:8787';
async function streamChat(body) {
  const resp = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) return { error: resp.status + ' ' + (await resp.text()).slice(0, 150) };
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', out = { reasoning: '', content: '', tools: [], files: [], finish: null, chunks: 0 };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const line of lines) {
      const m = /^data: (.*)$/.exec(line.trim());
      if (!m) continue;
      const d = m[1];
      if (d === '[DONE]') continue;
      let j; try { j = JSON.parse(d); } catch { continue; }
      out.chunks++;
      const delta = j.choices?.[0]?.delta || {};
      if (delta.reasoning_content) out.reasoning += delta.reasoning_content;
      if (delta.content) out.content += delta.content;
      if (delta.tool_calls) out.tools.push(delta.tool_calls[0].function);
      if (delta.file_output) out.files.push(delta.file_output);
      if (j.choices?.[0]?.finish_reason) out.finish = j.choices[0].finish_reason;
    }
  }
  return out;
}

console.log('=== A. 流式 + 思考链 ===');
let r = await streamChat({ model: 'sakana-namazu', stream: true, thinking: true, messages: [{ role: 'user', content: '9.9 和 9.11 哪个大?只回答结果' }] });
if (r.error) console.log('ERR', r.error);
else {
  console.log('chunks:', r.chunks, 'finish:', r.finish);
  console.log('reasoning head:', JSON.stringify(r.reasoning.slice(0, 120)));
  console.log('content:', JSON.stringify(r.content.slice(0, 300)));
}

console.log('=== B. 流式 + Web Search ===');
r = await streamChat({ model: 'sakana-namazu', stream: true, web_search: true, messages: [{ role: 'user', content: '今天东京天气如何?用中文简短回答' }] });
if (r.error) console.log('ERR', r.error);
else {
  console.log('chunks:', r.chunks, 'finish:', r.finish);
  console.log('tools seen:', JSON.stringify(r.tools.slice(0, 3)));
  console.log('content:', JSON.stringify(r.content.slice(0, 300)));
}
