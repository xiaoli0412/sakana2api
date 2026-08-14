import fs from 'fs';
import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const tk = JSON.parse(fs.readFileSync('tokens.json', 'utf8'));
const tok = tk.accessToken;
const expr = `(async () => {
  const tok = ${JSON.stringify(tok)};
  const variants = {
    'no-auth': {},
    'bearer-idToken': { authorization: 'Bearer ' + tok },
    'x-id-token': { 'x-id-token': tok },
    'x-firebase-token': { 'x-firebase-id-token': tok },
    'x-auth-token': { 'x-auth-token': tok },
    'cookie-token': { cookie: 'token=' + tok },
    'cookie-idToken': { cookie: 'idToken=' + tok },
  };
  const out = {};
  for (const [name, h] of Object.entries(variants)) {
    try {
      const r = await fetch('/api/rate-limit/status', { headers: { accept: 'application/json', ...h } });
      out[name] = { status: r.status, body: (await r.text()).slice(0, 100) };
    } catch (e) { out[name] = { error: String(e) }; }
  }
  return out;
})()`;
const r = await sess.evaluate(expr);
console.log(JSON.stringify(r, null, 1));
sess.close();
