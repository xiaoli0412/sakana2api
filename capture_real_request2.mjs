import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

// ensure we are on home page first
const urlNow = await sess.evaluate('location.href');
if (!urlNow.includes('chat.sakana.ai')) await sess.send('Page.navigate', { url: 'https://chat.sakana.ai/' });
await new Promise(r => setTimeout(r, 5000));

// NOW inject hook
await sess.evaluate(`(async () => {
  window.__cap3 = [];
  const of = window.fetch;
  window.fetch = async function(...args) {
    const u = String(args[0] || '');
    const init = args[1] || {};
    if (u.includes('/api/conversation') && init.method === 'POST') {
      const entry = { url: u };
      if (init.body instanceof FormData) {
        entry.formData = [];
        for (const [k, v] of init.body.entries()) {
          if (typeof v === 'string') entry.formData.push([k, 'string', v]);
          else entry.formData.push([k, 'file', v.type, v.name, v.size]);
        }
      } else {
        entry.jsonBody = typeof init.body === 'string' ? init.body : String(init.body);
      }
      entry.headers = init.headers instanceof Headers ? Array.from(init.headers.entries()) : init.headers;
      window.__cap3.push(entry);
      try { const resp = await of.apply(this, args); entry.status = resp.status; return resp; } catch(e) { entry.err = String(e); throw e; }
    }
    return of.apply(this, args);
  };
  return 'hooked';
})()`);

// send message via UI
const d = await sess.evaluate(`(async () => {
  const input = document.querySelector('textarea');
  if (!input) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  input.focus();
  setter.call(input, '你好,请回复一句话');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '你好,请回复一句话' }));
  await new Promise(r => setTimeout(r, 600));
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('send'));
  if (!btn) return { error: 'no send btn' };
  btn.click();
  return { sent: true };
})()`);
console.log('send:', JSON.stringify(d));
await new Promise(r => setTimeout(r, 12000));
console.log('CAPTURED:', JSON.stringify(await sess.evaluate('window.__cap3'), null, 1));
// also check for a reply in the DOM
const dom = await sess.evaluate('document.body.innerText.slice(0, 400)');
console.log('PAGE TEXT:', JSON.stringify(dom));
sess.close();
