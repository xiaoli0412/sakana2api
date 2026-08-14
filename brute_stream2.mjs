import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

const r = await sess.evaluate(`(async () => {
  const out = [];
  const variants = [
    { name: 'B-userMsgId=systemMsgId', data: (boot) => ({ inputs: '测试消息', id: crypto.randomUUID(), is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, userMessageId: boot.systemMessageId, model: 'sakana-namazu' }) },
    { name: 'C-no-inputs', data: () => ({ id: crypto.randomUUID(), is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, userMessageId: crypto.randomUUID(), model: 'sakana-namazu' }) },
    { name: 'E-uuidv4-ids', data: () => ({ inputs: '测试消息', id: crypto.randomUUID(), is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, userMessageId: crypto.randomUUID(), model: 'sakana-namazu' }) },
  ];
  // run each variant against its OWN fresh conversation
  for (const v of variants) {
    const boot = await fetch('/api/conversation', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ inputs: '测试消息', enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' })
    }).then(r => r.json());
    const fd = new FormData();
    fd.append('data', JSON.stringify(v.data(boot)));
    const resp = await fetch('/api/conversation/' + boot.conversationId, { method: 'POST', body: fd, credentials: 'include' });
    let body = '';
    try { body = (await resp.text()).slice(0, 300); } catch (e) { body = 'read-err ' + e; }
    out.push({ variant: v.name, status: resp.status, body });
  }
  return out;
})()`);
console.log(JSON.stringify(r, null, 1));
sess.close();
