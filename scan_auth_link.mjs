import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  const srcs = Array.from(document.querySelectorAll('script[src]')).map(s => s.src).filter(u => u.includes('/_next/'));
  const out = [];
  for (const u of srcs) {
    try {
      const text = await (await fetch(u)).text();
      // find where signInAnonymously is used and what happens with the token after
      let idx = text.indexOf('signInAnonymously');
      if (idx >= 0) out.push({ u: u.slice(u.lastIndexOf('/') + 1), kw: 'signInAnonymously', ctx: text.slice(Math.max(0, idx - 400), idx + 500) });
      // look for cookie named patterns with token
      for (const kw of ['__session', 'sb-token', 'authToken=', 'token=', '__Secure', 'X-Sakana', 'x-sakana', 'sakana-token']) {
        let i2 = text.indexOf('"' + kw + '"');
        if (i2 < 0) i2 = text.indexOf(kw);
        if (i2 >= 0) out.push({ u: u.slice(u.lastIndexOf('/') + 1), kw, ctx: text.slice(Math.max(0, i2 - 200), i2 + 250) });
      }
    } catch (e) {}
  }
  return out;
})()`);
console.log(JSON.stringify(r, null, 1).slice(0, 10000));
sess.close();
