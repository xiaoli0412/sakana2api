import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  const out = {};
  // bootstrap exactly like browser first-message flow
  const boot = await fetch('/api/conversation', {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ inputs: '复刻测试', enableThinking: false, toneMode: 'default', webSearchEnabled: true, model: 'sakana-namazu' })
  }).then(r => r.json());
  out.bootstrap = boot;
  // v4 userMessageId (browser), v7 style id (browser createMessageId)
  const uid = crypto.randomUUID();
  const id = crypto.randomUUID(); // browser uses uuid v7; try v4 first, then vs v7
  const fd = new FormData();
  fd.append('data', JSON.stringify({ inputs: '复刻测试', id, is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: true, userMessageId: uid, model: 'sakana-namazu' }));
  const resp = await fetch('/api/conversation/' + boot.conversationId, { method: 'POST', body: fd, credentials: 'include' });
  out.stream = { status: resp.status, body: (await resp.text()).slice(0, 200) };
  return out;
})()`);
console.log(JSON.stringify(r, null, 1));
sess.close();
