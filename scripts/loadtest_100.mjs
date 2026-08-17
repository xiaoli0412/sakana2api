// 100-concurrent real load test against a live sakana-2api deployment.
// Usage: node scripts/loadtest_100.mjs <base_url> <api_key> [concurrency] [nonStreamRatio]
// Fires N concurrent REAL chat/completions requests (stream + non-stream mix),
// then reports per-request outcome, latency distribution, server errors.
const base = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8799';
const key = process.argv[3] || process.env.SAKANA_TEST_KEY || '';
const CONCURRENCY = parseInt(process.argv[4] || process.env.CONCURRENCY || '100', 10);
const NONSTREAM_RATIO = parseFloat(process.argv[5] || process.env.NONSTREAM_RATIO || '0.3');

const t0 = Date.now();
const results = [];

async function oneRequest(i) {
  const isStream = Math.random() >= NONSTREAM_RATIO;
  const body = {
    model: 'sakana-namazu',
    messages: [{ role: 'user', content: `并发压测请求 #${i}: 请用一句话介绍你自己,不要超过20个字。` }],
    stream: isStream,
    enable_thinking: false,
    web_search: false,
  };
  const start = Date.now();
  try {
    const resp = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify(body),
    });
    let outText = '';
    let finishReason = '';
    if (isStream) {
      if (!resp.ok || !resp.body) {
        const t = await resp.text().catch(() => '');
        return { i, ok: false, stream: true, status: resp.status, ms: Date.now() - start, err: t.slice(0, 120) };
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { buf += dec.decode(); break; }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const ch = obj.choices?.[0];
            if (ch?.delta?.content) outText += ch.delta.content;
            if (ch?.finish_reason) finishReason = ch.finish_reason;
          } catch {}
        }
      }
      if (buf.startsWith('data:')) {
        const payload = buf.slice(5).trim();
        if (payload && payload !== '[DONE]') {
          try {
            const obj = JSON.parse(payload);
            const ch = obj.choices?.[0];
            if (ch?.delta?.content) outText += ch.delta.content;
            if (ch?.finish_reason) finishReason = ch.finish_reason;
          } catch {}
        }
      }
      return { i, ok: resp.status === 200 && outText.length > 0, stream: true, status: resp.status, ms: Date.now() - start, chars: outText.length, finish: finishReason, err: outText.length ? '' : 'empty stream' };
    } else {
      const j = await resp.json().catch(() => ({}));
      const text = j.choices?.[0]?.message?.content || '';
      return { i, ok: resp.status === 200 && text.length > 0, stream: false, status: resp.status, ms: Date.now() - start, chars: text.length, err: j.error?.message?.slice(0, 120) || (resp.status !== 200 ? 'HTTP ' + resp.status : 'empty content') };
    }
  } catch (e) {
    return { i, ok: false, stream: isStream, status: 0, ms: Date.now() - start, err: String(e.message || e).slice(0, 120) };
  }
}

console.log(`loadtest: ${base}  concurrency=${CONCURRENCY}  nonstreamRatio=${NONSTREAM_RATIO}  key=${key ? 'set' : 'NONE'}`);
const workers = [];
for (let i = 0; i < CONCURRENCY; i++) workers.push(oneRequest(i));
const all = await Promise.all(workers);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const okCount = all.filter(r => r.ok).length;
const failCount = all.length - okCount;
const statuses = {};
const errs = {};
for (const r of all) {
  statuses[r.status] = (statuses[r.status] || 0) + 1;
  if (!r.ok) errs[r.err || ('HTTP ' + r.status)] = (errs[r.err || ('HTTP ' + r.status)] || 0) + 1;
}
const lats = all.filter(r => r.ok).map(r => r.ms).sort((a, b) => a - b);
const pct = (p) => lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * p))] : 0;
const streamOk = all.filter(r => r.stream && r.ok);
const nonStreamOk = all.filter(r => !r.stream && r.ok);

console.log(`\n=== RESULT ===`);
console.log(`wall time: ${elapsed}s`);
console.log(`ok: ${okCount}/${all.length}  fail: ${failCount}`);
console.log(`stream ok: ${streamOk.length}  non-stream ok: ${nonStreamOk.length}`);
console.log(`statuses: ${JSON.stringify(statuses)}`);
if (Object.keys(errs).length) {
  console.log(`error kinds (top 8):`);
  Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, v]) => console.log(`  ${v}x  ${k}`));
}
if (lats.length) console.log(`latency(ok): p50=${pct(0.5)}ms p90=${pct(0.9)}ms p99=${pct(0.99)}ms min=${lats[0]}ms max=${lats[lats.length-1]}ms`);
process.exit(failCount ? 1 : 0);