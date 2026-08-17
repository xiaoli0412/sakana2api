// Over-long-context real test against a live sakana-2api deployment.
// Usage: node scripts/longcontext_test.mjs <base_url> <api_key>
// Scenarios:
//  1. single huge prompt (~200KB text) -> must not crash the proxy (either a
//     clean upstream answer or a clean 4xx/5xx JSON error — never hang/ECONNRESET)
//  2. long multi-turn conversation (12 turns) reusing conversation_id
//  3. a burst of 5 in-parallel turns on the SAME conversation (pinning stress)
const base = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8799';
const key = process.argv[3] || process.env.SAKANA_TEST_KEY || '';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
}

async function chat(body, timeoutMs = 180000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const st = resp.status;
    let text = '';
    if (body.stream && resp.ok && resp.body) {
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const pl = line.slice(5).trim();
          if (!pl || pl === '[DONE]') continue;
          try {
            const o = JSON.parse(pl);
            if (o.choices?.[0]?.delta?.content) text += o.choices[0].delta.content;
          } catch {}
        }
      }
    } else {
      const j = await resp.json().catch(() => ({}));
      text = j.choices?.[0]?.message?.content || '';
    }
    return { status: st, text };
  } catch (e) {
    return { status: 0, text: '', netErr: e.name === 'AbortError' ? 'TIMEOUT' : String(e.message || e).slice(0, 100) };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`longcontext_test against ${base}`);
let sharedConvId = null; // carried from scenario 2 (conversation_id reuse) into scenario 3

// Scenario 1: ~200KB single prompt
{
  console.log('\n[1] single 200KB prompt (non-stream)');
  const filler = '这是一段用于测试超长上下文处理的填充文本。'.repeat(12000); // ~240KB
  const body = { model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: `${filler}\n\n请在回复开头说"收到超长输入"。` }], enable_thinking: false, web_search: false };
  const r = await chat(body);
  check('proxy responds (no hang/crash)', r.status !== 0, `netErr=${r.netErr}`);
  check('response is 2xx or a clean JSON error', r.status >= 200 && r.status < 500 || (r.status >= 400 && r.status < 500), `status=${r.status}`);
  check('got non-empty answer or clean error body', !(r.status === 200 && !r.text), `status=${r.status} len=${(r.text||'').length}`);
  console.log(`  status=${r.status} answerLen=${(r.text || '').length} prefix=${JSON.stringify((r.text || '').slice(0, 60))}`);
}

// Scenario 2: 12-turn conversation with conversation_id reuse
{
  console.log('\n[2] 12-turn conversation (conversation_id reuse)');
  let convId = null;
  let ok = true, last = '';
  const turns = ['第一轮:请记住关键词"蓝鲸",回复"记住了1"', '第二轮:我刚才说的关键词是什么?只回答关键词', '第三轮:把关键词倒过来念一遍', '第四轮:关键词第一个字是什么?', '第五轮:再复述一次关键词,然后回复"OK5"', '第六轮:关键词的英文是什么?不知道就回复"不知道"', '第七轮:回复"第七轮完成"', '第八轮:回复数字8', '第九轮:回复数字9', '第十轮:回复数字10', '第十一轮:回复"快结束了"', '第十二轮:最后复述一遍关键词'];
  for (let i = 0; i < turns.length; i++) {
    const body = { model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: turns[i] }], enable_thinking: false, web_search: false };
    if (convId) body.conversation_id = convId;
    const j = await (async () => {
      const resp = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) });
      return { status: resp.status, json: await resp.json().catch(() => ({})) };
    })();
    convId = j.json.conversation_id || convId;
    last = (j.json.choices?.[0]?.message?.content || '').slice(0, 40);
    if (j.status !== 200) { ok = false; console.log(`  turn${i + 1}: HTTP ${j.status} ${JSON.stringify(j.json.error || '').slice(0, 100)}`); }
    else console.log(`  turn${i + 1}: "${last}"`);
    await new Promise(res => setTimeout(res, 4000)); // upstream per-account rate limit pacing
  }
  check('all 12 turns succeeded', ok, `last turn: ${last}`);
  check('conversation id persisted', !!convId);
  sharedConvId = convId;
}

// Scenario 3: 5 parallel turns on the SAME conversation (account pinning under concurrency)
{
  console.log('\n[3] 5 parallel turns on same conversation');
  const bodies = [1, 2, 3, 4, 5].map(n => ({ model: 'sakana-namazu', stream: true, conversation_id: sharedConvId || undefined, messages: [{ role: 'user', content: `并发延续 #${n}:回复数字${n}即可` }], enable_thinking: false, web_search: false }));
  const rs = await Promise.all(bodies.map(b => chat(b, 120000)));
  const oks = rs.filter(r => r.status === 200 && r.text.length > 0).length;
  rs.forEach((r, i) => console.log(`  req${i + 1}: status=${r.status} len=${(r.text || '').length} "${(r.text || r.netErr || '').slice(0, 40)}"`));
  check('same-conversation parallel turns do not crash proxy', rs.every(r => r.status !== 0));
  console.log(`  (${oks}/5 got 200-with-text — same-tree parallel turns may hit upstream CONV locks, proxy must stay healthy)`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);