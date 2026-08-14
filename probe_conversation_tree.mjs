import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

const r = await sess.evaluate(`(async () => {
  const out = {};
  // 1) bootstrap
  const bootResp = await fetch('/api/conversation', {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ inputs: '消息树测试', enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' })
  });
  const boot = await bootResp.json();
  out.bootstrap = boot;

  // 2) GET conversation tree to inspect messages
  const convResp = await fetch('/api/conversation/' + boot.conversationId, { credentials: 'include', headers: { accept: 'application/json' } });
  const conv = await convResp.json();
  out.getStatus = convResp.status;
  // summarize messages
  out.messages = (conv.messages || []).map(m => ({
    id: m.id, from: m.from, content: (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 60),
    ancestors: m.ancestors, children: m.children, role: m.role
  }));
  out.rawKeys = Object.keys(conv);
  return out;
})()`);
console.log(JSON.stringify(r, null, 1));
sess.close();
