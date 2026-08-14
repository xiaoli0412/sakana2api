import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  // hook BEFORE sending real UI message
  window.__cap4 = [];
  const of = window.fetch;
  window.fetch = async function(...args) {
    const u = String(args[0] || '');
    const init = args[1] || {};
    if (u.includes('/api/conversation') && init.method === 'POST') {
      const entry = { url: u };
      if (init.body instanceof FormData) {
        entry.fd = [];
        for (const [k, v] of init.body.entries()) {
          if (typeof v === 'string') entry.fd.push([k, 'string', v]);
          else {
            // byte dump first chunk of the file part
            const buf = new Uint8Array(await v.slice(0, 64).arrayBuffer());
            entry.fd.push([k, 'file', { type: v.type, name: v.name, size: v.size, headHex: Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('') }]);
          }
        }
        const hdrs = {};
        (init.headers instanceof Headers ? init.headers : new Headers(init.headers)).forEach((val, key) => hdrs[key] = val);
        entry.headers = hdrs;
      } else {
        entry.json = init.body;
      }
      window.__cap4.push(entry);
    }
    return of.apply(this, args);
  };
  return 'hooked';
})()`);
console.log(r);
// send real UI message
const d = await sess.evaluate(`(async () => {
  const input = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  input.focus(); setter.call(input, '你好,请回复一句话'); 
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '你好,请回复一句话' }));
  await new Promise(r => setTimeout(r, 600));
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('send'));
  btn.click(); return !!btn;
})()`);
console.log('sent:', d);
await new Promise(r => setTimeout(r, 14000));
console.log(JSON.stringify(await sess.evaluate('window.__cap4'), null, 1));
sess.close();
