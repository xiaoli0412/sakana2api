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
    body: JSON.stringify({ inputs: '第一轮', enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' })
  }).then(r => r.json());
  out.bootstrap = boot;
  // 2) stream text first (no files)
  let fd = new FormData();
  fd.append('data', JSON.stringify({ inputs: '第一轮', id: boot.systemMessageId, is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, userMessageId: crypto.randomUUID(), model: 'sakana-namazu' }));
  let resp = await fetch('/api/conversation/' + boot.conversationId, { method: 'POST', body: fd, credentials: 'include' });
  const text1 = await resp.text();
  out.turn1 = { status: resp.status, head: text1.slice(0, 80) };
  // 3) now get conversation to find last message id
  const conv = await fetch('/api/conversation/' + boot.conversationId, { credentials: 'include', headers: { accept: 'application/json' } }).then(r => r.json());
  out.msgs = conv.messages.map(m => ({ id: m.id, from: m.from }));
  const lastId = conv.messages[conv.messages.length - 1].id;
  // 4) stream with file on second turn
  fd = new FormData();
  fd.append('data', JSON.stringify({ inputs: '这张图片什么颜色', id: lastId, is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, userMessageId: crypto.randomUUID(), model: 'sakana-namazu' }));
  fd.append('files', new File([bin], 'base64;red64.png', { type: 'image/png' }));
  resp = await fetch('/api/conversation/' + boot.conversationId, { method: 'POST', body: fd, credentials: 'include' });
  out.turn2 = { status: resp.status, head: (await resp.text()).slice(0, 200) };
  return out;
})()`);
console.log(JSON.stringify(r, null, 1));
sess.close();
