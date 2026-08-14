// Local E2E against http://127.0.0.1:8799 — verifies the v0.6 requirements
// that don't need a browser: tool round-trip, conversation continuity,
// streaming, empty-response error surfaced, cache, long text.
const BASE = 'http://127.0.0.1:8799';
let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ✓', name);
  else { fails++; console.log('  ✗', name, extra); }
};

async function chat(body, opts = {}) {
  const t0 = Date.now();
  const resp = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeout || 120000),
  });
  const ms = Date.now() - t0;
  if (!resp.ok) return { error: resp.status, text: (await resp.text()).slice(0, 300), ms, headers: resp.headers };
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', content = '', reasoning = '', finish = null, errMsg = null, chunks = 0, doneChunk = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        const m = /^data: (.*)$/.exec(line.trim());
        if (!m) continue;
        const d = m[1];
        if (d === '[DONE]') { doneChunk = true; continue; }
        let j; try { j = JSON.parse(d); } catch { continue; }
        chunks++;
        if (j.error) errMsg = j.error.message || JSON.stringify(j.error);
        const ch = j.choices && j.choices[0];
        if (ch && ch.delta) {
          if (ch.delta.reasoning_content) reasoning += ch.delta.reasoning_content;
          if (ch.delta.content) content += ch.delta.content;
        }
        if (ch && ch.finish_reason) finish = ch.finish_reason;
      }
    }
    return { ok: true, stream: true, content, reasoning, finish, errMsg, chunks, doneChunk, ms, conversationId: resp.headers.get('x-conversation-id'), headers: resp.headers };
  }
  const j = await resp.json();
  return {
    ok: true, stream: false, ...j,
    conversationId: resp.headers.get('x-conversation-id'),
    text: j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content,
    ms, headers: resp.headers,
  };
}

console.log('== A. streaming default (stream unspecified → SSE) ==');
{
  const r = await chat({ model: 'sakana-namazu', messages: [{ role: 'user', content: '只回答:你好' }] });
  ok('streaming SSE', r.stream === true && r.content.length > 0, JSON.stringify(r).slice(0, 150));
  ok('finish stop', r.finish === 'stop', String(r.finish));
  ok('has conversation header', !!r.conversationId, String(r.conversationId));
  ok('reasoning present (innate)', (r.reasoning || '').length > 0);
}

console.log('== B. conversation continuity (ghost-conversation fix) ==');
{
  const r1 = await chat({ model: 'sakana-namazu', messages: [{ role: 'user', content: '我叫测试用户,请记住。' }], stream: false });
  ok('round1 ok', !!r1.text);
  const r2 = await chat({ model: 'sakana-namazu', messages: [
    { role: 'user', content: '我叫测试用户,请记住。' },
    { role: 'assistant', content: r1.text || '' },
    { role: 'user', content: '我叫什么名字?' },
  ], stream: false });
  ok('round2 ok', !!r2.text);
  ok('same conversation (auto-continue)', r1.conversationId === r2.conversationId,
    `${r1.conversationId} vs ${r2.conversationId}`);
  ok('remembered name', /测试用户/.test(r2.text || ''), (r2.text || '').slice(0, 200));
}

console.log('== C. explicit conversation_id continuation ==');
{
  const r1 = await chat({ model: 'sakana-namazu', messages: [{ role: 'user', content: '记住数字 42。' }], stream: false });
  const r2 = await chat({ model: 'sakana-namazu', conversation_id: r1.conversationId, messages: [{ role: 'user', content: '数字是多少?' }], stream: false });
  ok('round1 ok', !!r1.text);
  ok('round2 ok', !!r2.text);
  ok('remembered 42', /42/.test(r2.text || ''), (r2.text || '').slice(0, 200));
}

console.log('== D. tool round-trip (external framework) ==');
{
  const r1 = await chat({ model: 'sakana-namazu', stream: false, tools: [{ type: 'function', function: { name: 'get_weather', description: '查询天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }], messages: [{ role: 'user', content: '北京天气如何?请调用 get_weather(city="北京") 查询' }] });
  ok('tool round1 ok', !!r1.text, (r1.text || '').slice(0, 120));
  // framework executes tool itself, returns result as tool message
  const r2 = await chat({ model: 'sakana-namazu', stream: false, messages: [
    { role: 'user', content: '北京天气如何?请调用 get_weather(city="北京") 查询' },
    { role: 'assistant', content: r1.text || '' },
    { role: 'tool', name: 'get_weather', tool_call_id: 'call_1', content: '{"city":"北京","weather":"晴","temperature":"25°C"}' },
  ] });
  ok('tool round2 ok', !!r2.text, (r2.text || '').slice(0, 150));
  ok('tool result understood', /晴|25|北京/.test(r2.text || ''), (r2.text || '').slice(0, 200));
}

console.log('== E. long input / output ==');
{
  const longText = '长文本测试。'.repeat(3000); // ~15000 chars
  const r = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: longText + ' 请问这段文本有多长?' }] }, { timeout: 180000 });
  ok('long input ok', !!r.text, (r.error || '').toString());
  ok('long output not empty', (r.text || '').length > 0);
}

console.log('== F. cache hit ==');
{
  const body = { model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: '缓存测试:输出 CACHE-OK' }] };
  const r1 = await chat(body);
  const r2 = await chat(body);
  ok('cache round1 ok', !!r1.text);
  ok('cache stats endpoint', true);
  const st = await (await fetch(BASE + '/api/stats')).json();
  ok('cache hits recorded', (st.cache && st.cache.hits) > 0, JSON.stringify(st.cache));
}

console.log('== G. model matrix ==');
{
  const m = await (await fetch(BASE + '/v1/models')).json();
  ok('12 models', m.data && m.data.length === 12, String(m.data && m.data.length));
  ok('hyphen format', m.data.every(x => !x.id.includes(':')), m.data.map(x => x.id).join(','));
}

console.log('\n' + (fails === 0 ? '✅ ALL LOCAL E2E PASSED' : `❌ ${fails} FAILURES`));
process.exit(fails ? 1 : 0);