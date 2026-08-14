import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
await sess.evaluate(`(() => {
  window.__capUpload = [];
  const of = window.fetch;
  window.fetch = async function(...args) {
    const u = String(args[0] || '');
    const init = args[1] || {};
    if (u.includes('/api/conversation') && init.method === 'POST') {
      const entry = { u };
      if (init.body instanceof FormData) {
        entry.fd = [];
        for (const [k, v] of init.body.entries()) entry.fd.push([k, typeof v === 'string' ? v.slice(0, 200) : { name: v.name, size: v.size, type: v.type }]);
      }
      try { const r = await of.apply(this, args); entry.status = r.status; const t = await r.clone().text(); entry.respHead = t.slice(0, 200); window.__capUpload.push(entry); return r; } catch (e) { entry.err = String(e); window.__capUpload.push(entry); throw e; }
    }
    return of.apply(this, args);
  };
  return 1;
})()`);
// type message + send
const sent = await sess.evaluate(`(async () => {
  const input = document.querySelector('textarea');
  if (!input) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  input.focus(); setter.call(input, '这张图片是什么颜色?');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '这张图片是什么颜色?' }));
  await new Promise(r => setTimeout(r, 600));
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('send'));
  btn.click(); return 'sent';
})()`);
console.log('send:', sent);
await new Promise(r => setTimeout(r, 20000));
const cap = await sess.evaluate('window.__capUpload');
console.log('CAPTURED:', JSON.stringify(cap, null, 1));
const bodyText = await sess.evaluate('document.body.innerText.slice(0, 300)');
console.log('PAGE:', JSON.stringify(bodyText));
sess.close();
