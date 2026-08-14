import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
// Fetch each chunk in page context (same-origin + CF cookies) and scan for auth-related keywords
const r = await sess.evaluate(`(async () => {
  const srcs = Array.from(document.querySelectorAll('script[src]')).map(s => s.src).filter(u => u.includes('/_next/'));
  const hits = [];
  for (const u of srcs) {
    try {
      const text = await (await fetch(u)).text();
      const keywords = ['AUTH-LOGIN', 'authorization', 'Authorization', 'bearer', 'getIdToken', 'idToken', 'x-auth', 'x-firebase', 'webSearchEnabled', 'enableThinking', 'toneMode', '/api/conversation'];
      const found = {};
      for (const kw of keywords) {
        let idx = text.indexOf(kw);
        if (idx >= 0) {
          found[kw] = text.slice(Math.max(0, idx - 150), idx + 250);
        }
      }
      if (Object.keys(found).length) hits.push({ u: u.slice(u.lastIndexOf('/') + 1), size: text.length, found });
    } catch (e) {}
  }
  return hits;
})()`);
console.log(JSON.stringify(r, null, 2).slice(0, 12000));
sess.close();
