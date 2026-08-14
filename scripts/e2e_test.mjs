// Full OpenAI-compatible E2E through the proxy (Node client, UTF-8 safe).
const BASE = 'http://127.0.0.1:8787';

async function chat({ stream = true, messages, model = 'sakana-namazu', extra = {} } = {}) {
  const body = { model, messages, stream, ...extra };
  const resp = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { resp, body };
}

console.log('=== TEST 1: non-stream, thinking ===');
{
  const { resp } = await chat({ stream: false, extra: { thinking: true }, messages: [{ role: 'user', content: '你好!请用中文回复,只回一句。' }] });
  console.log('status:', resp.status);
  const j = await resp.json();
  console.log('content:', JSON.stringify(j.choices?.[0]?.message?.content));
  console.log('reasoning len:', (j.choices?.[0]?.message?.reasoning_content || '').length);
}
