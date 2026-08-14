// Remote E2E against http://38.76.190.150:8787 — full requirements verification.
// Run from the machine with the ssh secret (or locally, hitting the public URL).
const BASE = 'http://38.76.190.150:8787';
const KEY = process.env.SAKANA_TEST_KEY || '';
const AUTH = { authorization: 'Bearer ' + KEY };
let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  PASS', name);
  else { fails++; console.log('  FAIL', name, extra); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function chat(body, timeout = 150000) {
  const t0 = Date.now();
  const resp = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  const ms = Date.now() - t0;
  const ct = resp.headers.get('content-type') || '';
  if (!resp.ok) return { error: resp.status, text: (await resp.text()).slice(0, 200), ms };
  if (ct.includes('event-stream')) {
    const reader = resp.body.getReader(); const dec = new TextDecoder();
    let buf = '', content = '', reasoning = '', finish = null, errMsg = null;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        const m = /^data: (.*)$/.exec(line.trim()); if (!m) continue;
        const d = m[1]; if (d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch { continue; }
        if (j.error) errMsg = j.error.message || JSON.stringify(j.error);
        const ch = j.choices && j.choices[0];
        if (ch && ch.delta) { if (ch.delta.reasoning_content) reasoning += ch.delta.reasoning_content; if (ch.delta.content) content += ch.delta.content; }
        if (ch && ch.finish_reason) finish = ch.finish_reason;
      }
    }
    return { ok: true, stream: true, content, reasoning, finish, errMsg, ms, conversationId: resp.headers.get('x-conversation-id') };
  }
  const j = await resp.json();
  return { ok: true, stream: false, ...j, text: j.choices?.[0]?.message?.content || '', ms, conversationId: resp.headers.get('x-conversation-id') };
}

console.log('== R1. pool: 10 distinct accounts ==');
{
  const r = await fetch(BASE + '/api/accounts', { headers: AUTH });
  const j = await r.json();
  const emails = new Set((j.accounts || []).map(a => a.email).filter(Boolean));
  const uids = new Set((j.accounts || []).map(a => a.uid).filter(Boolean));
  const active = (j.accounts || []).filter(a => a.state === 'active').length;
  ok('10 accounts', (j.accounts || []).length >= 10, 'got ' + (j.accounts || []).length);
  ok('10 distinct emails', emails.size >= 10, emails.size + ' distinct');
  ok('10 distinct uids', uids.size >= 10, uids.size + ' distinct');
  ok('all active', active >= 10, active + ' active');
}

console.log('== R2. basic chat streaming ==');
{
  const r = await chat({ model: 'sakana-namazu', messages: [{ role: 'user', content: '只回答:远程OK' }] });
  ok('stream ok', r.stream === true && r.content.length > 0, JSON.stringify(r).slice(0, 120));
  ok('finish stop', r.finish === 'stop', String(r.finish));
  ok('conversation header', !!r.conversationId);
}

console.log('== R3. image upload (multimodal) ==');
{
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // use a bigger real PNG: generate 32x32 red data URL client-side via zlib? Simpler: reuse embedded known-good:
  // We'll build a 16x16 red PNG via our own code is complex here; use a known base64 of a real red png:
  const realPng = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAFklEQVR4nGP8z8Dwn4GBgYGBgYGBgQA+pQI1v8vNPQAAAABJRU5ErkJggg==';
  const r = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: [
    { type: 'text', text: '这张图片是什么颜色?只回答两个字。' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + realPng } },
  ] }] }, 200000);
  const text = r.text || '';
  ok('image 200', !r.error, JSON.stringify(r).slice(0, 150));
  ok('image answered a color', /红|蓝|绿|白|黑/.test(text), text.slice(0, 80));

  // text file
  const fileData = 'data:text/plain;base64,' + Buffer.from('机密数字 8848').toString('base64');
  const rf = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: [
    { type: 'text', text: '文件里的机密数字是什么?只回答数字。' },
    { type: 'file', name: 'secret.txt', mime: 'text/plain', file_url: fileData },
  ] }] });
  ok('file extracted', /8848/.test(rf.text || ''), (rf.text || '').slice(0, 100));
}

console.log('== R4. conversation continuity (ghost fix) ==');
{
  const r1 = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: '我叫小李,记住。' }] });
  const r2 = await chat({ model: 'sakana-namazu', stream: false, messages: [
    { role: 'user', content: '我叫小李,记住。' },
    { role: 'assistant', content: r1.text || '' },
    { role: 'user', content: '我叫什么?' },
  ] });
  ok('r1 ok', !!r1.text);
  ok('r2 ok', !!r2.text);
  ok('same conversation', r1.conversationId === r2.conversationId, `${r1.conversationId} vs ${r2.conversationId}`);
  ok('remembered name', /小李/.test(r2.text || ''), (r2.text || '').slice(0, 150));
}

console.log('== R5. tool round-trip ==');
{
  const r1 = await chat({ model: 'sakana-namazu', stream: false, tools: [{ type: 'function', function: { name: 'get_weather', description: '天气' } }], messages: [{ role: 'user', content: '北京天气?调用 get_weather 查' }] });
  const r2 = await chat({ model: 'sakana-namazu', stream: false, messages: [
    { role: 'user', content: '北京天气?调用 get_weather 查' },
    { role: 'assistant', content: r1.text || '' },
    { role: 'tool', name: 'get_weather', tool_call_id: 'call_1', content: '{"weather":"晴","temp":"25C"}' },
  ] });
  ok('tool r1 ok', !!r1.text);
  ok('tool r2 ok', !!r2.text);
  ok('tool result understood', /晴|25/.test(r2.text || ''), (r2.text || '').slice(0, 150));
}

console.log('== R6. multi-format endpoints ==');
{
  const r =  await fetch(BASE + '/v1/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify({ model: 'sakana-namazu', prompt: '回答: legacy', max_tokens: 10 }), signal: AbortSignal.timeout(120000) });
  const j = await r.json();
  ok('legacy completions 200 + text', r.ok && !!j.choices?.[0]?.text, JSON.stringify(j).slice(0, 120));

  const r2 =  await fetch(BASE + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify({ model: 'sakana-namazu', input: '回答: response' }), signal: AbortSignal.timeout(120000) });
  const j2 = await r2.json();
  ok('responses 200 + output_text', r2.ok && !!j2.output?.[0]?.content?.[0]?.text, JSON.stringify(j2).slice(0, 120));

  const r3 =  await fetch(BASE + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify({ model: 'sakana-namazu', messages: [{ role: 'user', content: '回答: anthropic' }] }), signal: AbortSignal.timeout(120000) });
  const j3 = await r3.json();
  ok('anthropic 200 + text', r3.ok && !!j3.content?.[0]?.text, JSON.stringify(j3).slice(0, 120));
}

console.log('== R7. cache + stats ==');
{
  const body = { model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: '缓存测试:输出 CACHE-REMOTE-OK' }] };
  await chat(body);
  await chat(body);
  const st = await (await fetch(BASE + '/api/stats', { headers: AUTH })).json();
  ok('cache hits > 0', (st.cache && st.cache.hits) > 0, JSON.stringify(st.cache));
  ok('accounts in stats', st.accounts && st.accounts.total >= 10, JSON.stringify(st.accounts));
}

console.log('== R8. model matrix ==');
{
  const m = await (await fetch(BASE + '/v1/models', { headers: AUTH })).json();
  ok('12 models', m.data && m.data.length === 12, String(m.data && m.data.length));
}

console.log('\n' + (fails === 0 ? 'ALL REMOTE E2E PASSED' : fails + ' FAILURES'));
process.exit(fails ? 1 : 0);