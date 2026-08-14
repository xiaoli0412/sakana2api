import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

const r = await sess.evaluate(`(async () => {
  const out = {};
  // 1) bootstrap exactly like browser
  const bootResp = await fetch('/api/conversation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ inputs: '你好', enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' })
  });
  const bootJson = await bootResp.json();
  out.bootstrap = { status: bootResp.status, json: bootJson };
  const convId = bootJson.conversationId;
  if (!convId) return out;

  // 2) stream exactly like browser (FormData + fresh uuid)
  const fd = new FormData();
  fd.append('data', JSON.stringify({
    inputs: '你好', id: crypto.randomUUID(), is_retry: false, is_continue: false,
    enableThinking: false, toneMode: 'default', webSearchEnabled: false,
    userMessageId: crypto.randomUUID(), model: 'sakana-namazu'
  }));
  const streamResp = await fetch('/api/conversation/' + convId, { method: 'POST', body: fd, credentials: 'include' });
  out.stream = { status: streamResp.status, ct: streamResp.headers.get('content-type') };
  const text = await streamResp.text();
  out.stream.bodyHead = text.slice(0, 600);
  out.stream.bodyLen = text.length;
  return out;
})()`);
console.log(JSON.stringify(r, null, 1));
sess.close();
