import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  const srcs = Array.from(document.querySelectorAll('script[src]')).map(s => s.src).filter(u => u.includes('/_next/'));
  const out = [];
  for (const u of srcs) {
    try {
      const text = await (await fetch(u)).text();
      for (const kw of ['AUTH-LOGIN-001', 'AUTH-TOKEN-001', 'AUTH-UNAUTH-001']) {
        let idx = text.indexOf('"' + kw + '"');
        if (idx < 0) idx = text.indexOf(kw);
        if (idx >= 0) {
          out.push({ u: u.slice(u.lastIndexOf('/') + 1), kw, ctx: text.slice(Math.max(0, idx - 350), idx + 450) });
        }
      }
    } catch (e) {}
  }
  return out;
})()`);
console.log(JSON.stringify(r, null, 1).slice(0, 10000));
sess.close();
