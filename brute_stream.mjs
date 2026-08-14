import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

const r = await sess.evaluate(`(async () => {
  const out = [];
  // fresh bootstrap per variant (one conversation each to avoid cross-state)
  for (let i = 0; i < 6; i++) {
    const boot = await fetch('/api/conversation', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ inputs: '测试消息', enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' })
    }).then(r => r.json());

    const variants = [
      { name: 'A-no-userMsgId-no-inputs', data: { inputs: '测试消息', id: crypto.randomUUID(), is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' } },
      { name: 'B-userMsgId=systemMsgId', data: { inputs: '测试消息', id: crypto.randomUUID(), is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, userMessageId: boot.systemMessageId, model: 'sakana-namazu' } },
      { name: 'C-no-inputs', data: { id: crypto.randomUUID(), is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, userMessageId: crypto.randomUUID(), model: 'sakana-namazu' } },
      { name: 'D-inputs-only', data: { inputs: '测试消息', id: crypto.randomUUID(), is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' } },
      { name: 'E-toneMode+status', data: { inputs: '测试消息', id: crypto.randomUUID(), is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, userMessageId: crypto.randomUUID(), model: 'sakana-namazu' } },
      { name: 'F-id=systemMsgId', data: { inputs: '测试消息', id: boot.systemMessageId, is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' } },
    ];
    const v = variants[i];
    const fd = new FormData();
    fd.append('data', JSON.stringify(v.data));
    const resp = await fetch('/api/conversation/' + boot.conversationId, { method: 'POST', body: fd, credentials: 'include' });
    let body = '';
    try { body = (await resp.text()).slice(0, 300); } catch (e) { body = 'read-err ' + e; }
    out.push({ variant: v.name, status: resp.status, body });
    break; // try one per run to avoid rate issues? no - do all, conversations are fresh
  }
  return out;
})()`);
console.log(JSON.stringify(r, null, 1));
sess.close();
