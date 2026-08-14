import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  const srcs = Array.from(document.querySelectorAll('script[src]')).map(s => s.src).filter(u => u.includes('/_next/'));
  const hits = [];
  for (const u of srcs) {
    try {
      const text = await (await fetch(u)).text();
      for (const kw of ['document.cookie', 'cookie=', 'CHIPS', 'partitioned', 'SessionCookie', 'createSessionCookie', 'token=Bearer', 'setCookie', 'getToken()', 'auth-token', 'authToken']) {
        let idx = text.indexOf(kw);
        if (idx >= 0) {
          hits.push({ u: u.slice(u.lastIndexOf('/') + 1), kw, ctx: text.slice(Math.max(0, idx - 200), idx + 300) });
        }
      }
      // also look for conversation API in this chunk family + how token attached (search for "AUTH-TOKEN" / error handling "r(o)")
      for (const kw of ['AUTH-TOKEN', 'conversationId']) {
        let idx = text.indexOf(kw);
        if (idx >= 0) hits.push({ u: u.slice(u.lastIndexOf('/') + 1), kw, ctx: text.slice(Math.max(0, idx - 250), idx + 400) });
      }
    } catch (e) {}
  }
  return hits;
})()`);
console.log(JSON.stringify(r, null, 2).slice(0, 14000));
sess.close();
