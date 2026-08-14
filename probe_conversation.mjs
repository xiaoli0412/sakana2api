import fs from 'fs';
import { findPageTarget, CdpSession } from './lib/cdp.js';

const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const tk = JSON.parse(fs.readFileSync('tokens.json', 'utf8'));

// Inject capture-hook + fire real conversation request using harvested idToken
const expr = `(async () => {
  window.__apiCap = [];
  const of = window.fetch;
  window.fetch = async function(...args) {
    const u = String(args[0] || '');
    let hdrs = null;
    try {
      const init = args[1] || {};
      hdrs = {};
      if (init.headers instanceof Headers) init.headers.forEach((v, k) => hdrs[k] = v);
      else if (init.headers) hdrs = Object.assign({}, init.headers);
    } catch (e) {}
    const resp = await of.apply(this, args);
    if (u.includes('/api/conversation')) {
      const t = await resp.clone().text();
      window.__apiCap.push({ url: u, status: resp.status, reqHeaders: hdrs, respHead: t.slice(0, 3000), respLen: t.length });
    }
    return resp;
  };
  const tok = ${JSON.stringify(tk.accessToken)};
  const resp = await fetch('/api/conversation', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + tok },
    body: JSON.stringify({ inputs: '你好,请用一句中文回复', enableThinking: true, toneMode: 'default', webSearchEnabled: true, model: 'sakana-namazu' })
  });
  return { status: resp.status, cap: window.__apiCap };
})()`;

const r = await sess.evaluate(expr);
console.log('RESULT:', JSON.stringify(r).slice(0, 4000));
sess.close();
