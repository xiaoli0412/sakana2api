import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  const srcs = Array.from(document.querySelectorAll('script[src]')).map(s => s.src).filter(u => u.includes('/_next/'));
  const found = [];
  for (const u of srcs) {
    try {
      const text = await (await fetch(u)).text();
      let idx = text.indexOf('INPUT-REQ');
      if (idx >= 0) found.push({ u: u.slice(u.lastIndexOf('/') + 1), ctx: text.slice(Math.max(0, idx - 200), idx + 200) });
    } catch (e) {}
  }
  return found;
})()`);
console.log(JSON.stringify(r, null, 1));
sess.close();
