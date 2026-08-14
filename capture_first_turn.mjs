import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

// reload to get a clean page
await sess.send('Page.navigate', { url: 'https://chat.sakana.ai/' });
await new Promise(r => setTimeout(r, 7000));

// hook everything /api/ (bodies included)
await sess.evaluate(`(() => {
  window.__cap5 = [];
  const of = window.fetch;
  window.fetch = async function(...args) {
    const u = String(args[0] || '');
    const init = args[1] || {};
    if (u.includes('/api/')) {
      const entry = { u, m: init.method || 'GET' };
      if (init.body instanceof FormData) {
        entry.fd = [];
        for (const [k, v] of init.body.entries()) entry.fd.push([k, typeof v === 'string' ? v : v.name]);
      } else if (typeof init.body === 'string') entry.body = init.body;
      const hdrs = {};
      (init.headers instanceof Headers ? init.headers : new Headers(init.headers || {})).forEach((v, k) => hdrs[k] = v);
      entry.hdrs = hdrs;
      window.__cap5.push(entry);
      try { const r = await of.apply(this, args); entry.resp = r.status; return r; } catch (e) { entry.err = String(e); throw e; }
    }
    return of.apply(this, args);
  };
  return 'ok';
})()`);

// input first message
const sent = await sess.evaluate(`(async () => {
  const input = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  input.focus(); setter.call(input, '第一轮测试:1+1=?');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '第一轮测试:1+1=?' }));
  await new Promise(r => setTimeout(r, 600));
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('send'));
  btn.click(); return !!btn;
})()`);
console.log('sent:', sent);
await new Promise(r => setTimeout(r, 18000));
console.log('SEQUENCE:', JSON.stringify(await sess.evaluate('window.__cap5'), null, 1));
sess.close();
