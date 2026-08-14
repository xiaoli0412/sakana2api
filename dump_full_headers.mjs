import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

const captured = [];
sess.on('Network.requestWillBeSent', (p) => {
  if (p.request.url.includes('/api/conversation/') && p.request.method === 'POST') {
    captured.push({ url: p.request.url.slice(0, 80), headers: p.request.headers });
  }
});
await sess.send('Network.enable');

// trigger one real UI send
const sent = await sess.evaluate(`(async () => {
  const input = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  input.focus(); setter.call(input, '再测试一次');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '再测试一次' }));
  await new Promise(r => setTimeout(r, 600));
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('send'));
  btn.click(); return !!btn;
})()`);
console.log('sent:', sent);
await new Promise(r => setTimeout(r, 8000));
const streamReq = captured.find(c => !c.url.includes('/stop'));
console.log('REAL STREAM REQUEST HEADERS:'); 
for (const [k, v] of Object.entries(streamReq ? streamReq.headers : {})) console.log(' ', k + ':', v.slice(0, 120));
sess.close();
