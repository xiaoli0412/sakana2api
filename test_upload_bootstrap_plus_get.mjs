import fs from 'fs';
import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const pngB64 = fs.readFileSync('red64.png').toString('base64');
const r = await sess.evaluate(`(async () => {
  const pngB64 = ${JSON.stringify(pngB64)};
  const bin = Uint8Array.from(atob(pngB64), c => c.charCodeAt(0));
  const out = {};
  // 1) bootstrap
  const boot = await fetch('/api/conversation', {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ inputs: '这张图片什么颜色', enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' })
  }).then(r => r.json());
  out.bootstrap = boot;
  // 2) GET conversation to get user message id
  const conv = await fetch('/api/conversation/' + boot.conversationId, { credentials: 'include', headers: { accept: 'application/json' } }).then(r => r.json());
  out.msgs = conv.messages.map(m => ({ id: m.id, from: m.from }));
  // find the user message id
  const userMsg = conv.messages.find(m => m.from === 'user');
  if (!userMsg) { out.error = 'no user msg'; return out; }
  const lastId = userMsg.id;
  out.userMsgId = lastId;
  // 3) stream with file, using user message id as 'id'
  const fd = new FormData();
  fd.append('data', JSON.stringify({ inputs: '这张图片什么颜色', id: lastId, is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, userMessageId: crypto.randomUUID(), model: 'sakana-namazu' }));
  fd.append('files', new File([bin], 'base64;red64.png', { type: 'image/png' }));
  const resp = await fetch('/api/conversation/' + boot.conversationId, { method: 'POST', body: fd, credentials: 'include' });
  out.stream = { status: resp.status, head: (await resp.text()).slice(0, 200) };
  return out;
})()`);
console.log(JSON.stringify(r, null, 1));
sess.close();
