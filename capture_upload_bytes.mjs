import fs from 'fs';
import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const pngB64 = fs.readFileSync('red.png').toString('base64');
const r = await sess.evaluate(`(async () => {
  const pngB64 = ${JSON.stringify(pngB64)};
  const bin = Uint8Array.from(atob(pngB64), c => c.charCodeAt(0));
  const fd = new FormData();
  fd.append('data', JSON.stringify({ inputs: '这张图片什么颜色', id: crypto.randomUUID(), is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, userMessageId: crypto.randomUUID(), model: 'sakana-namazu' }));
  fd.append('files', new File([bin], 'image;image-1.png', { type: 'image/png' }));
  const raw = await new Response(fd).arrayBuffer();
  const bytes = new Uint8Array(raw);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return { head: s.slice(0, 900), len: bytes.length };
})()`);
console.log(JSON.stringify(r, null, 1));
sess.close();
