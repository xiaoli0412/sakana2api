import { findPageTarget, CdpSession } from './lib/cdp.js';
import fs from 'fs';

const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

// Poll IndexedDB for firebase tokens
const pollIndexedDBExpr = `new Promise((resolve) => {
  let attempts = 0;
  const tryRead = () => {
    attempts++;
    try {
      const req = indexedDB.open('firebaseLocalStorageDb');
      req.onerror = () => (attempts > 20 ? resolve({ error: 'open-failed' }) : setTimeout(tryRead, 1000));
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('firebaseLocalStorage', 'readonly');
        const store = tx.objectStore('firebaseLocalStorage');
        const g = store.getAll();
        g.onsuccess = () => {
          const rows = g.result || [];
          const auth = rows.map(r => r && r.value).filter(v => v && v.idToken);
          if (auth.length) {
            const v = auth[0];
            resolve({ idToken: v.idToken, refreshToken: v.refreshToken || '', uid: v.uid || '', attempts, at: Date.now() });
          } else if (attempts > 60) {
            resolve({ error: 'no-idtoken', attempts });
          } else {
            setTimeout(tryRead, 1000);
          }
        };
      };
    } catch (e) {
      if (attempts > 20) resolve({ error: String(e), attempts });
      else setTimeout(tryRead, 1000);
    }
  };
  tryRead();
})`;

console.log('[1/4] waiting for anonymous Firebase signup (idToken)...');
const auth = await sess.evaluate(pollIndexedDBExpr);
console.log('auth result:', JSON.stringify({ ...auth, idToken: auth.idToken ? auth.idToken.slice(0, 40) + '...' : auth.idToken, refreshToken: auth.refreshToken ? auth.refreshToken.slice(0, 20) + '...' : auth.refreshToken }));
if (!auth.idToken) { console.error('FAILED to get idToken'); process.exit(1); }

// Cookies + UA
const ua = await sess.evaluate('navigator.userAgent');
const cookiesRaw = await sess.send('Network.getAllCookies').then(r => r.cookies || []);
const cookies = cookiesRaw.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure }));
console.log(`[2/4] got ${cookies.length} cookies, UA length ${ua.length}`);

// Inject fetch hook to capture /api/conversation
await sess.evaluate(`(() => {
  if (window.__2apiHook) return 'already';
  window.__2apiHook = true;
  window.__2apiCap = [];
  const of = window.fetch;
  window.fetch = async function(...args) {
    const u = String(args[0] || '');
    let headers = null;
    try {
      const init = args[1] || {};
      headers = {};
      if (init.headers instanceof Headers) init.headers.forEach((val, key) => headers[key] = val);
      else if (init.headers && typeof init.headers === 'object') headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k, String(v)]));
    } catch (e) {}
    const resp = await of.apply(this, args);
    if (u.includes('/api/') && !u.includes('rate-limit')) {
      window.__2apiCap.push({ url: u, method: (args[1] && args[1].method) || 'GET', status: resp.status, headers, bodyLen: 0 });
      const idx = window.__2apiCap.length - 1;
      resp.clone().text().then(t => { window.__2apiCap[idx].bodyLen = t.length; window.__2apiCap[idx].bodyHead = t.slice(0, 2500); }).catch(() => {});
    }
    return resp;
  };
  return 'hooked';
})()`);
console.log('[3/4] fetch hook installed');

// Probe model/config endpoints with auth
const probes = await sess.evaluate(`(async () => {
  const out = {};
  for (const p of ['/api/rate-limit/status', '/api/models', '/api/config', '/api/health']) {
    try {
      const r = await fetch(p, { headers: { accept: 'application/json' } });
      out[p] = { status: r.status, body: (await r.text()).slice(0, 500) };
    } catch (e) { out[p] = { error: String(e) }; }
  }
  return out;
})()`);
console.log('[4/4] probes:');
for (const [k, v] of Object.entries(probes)) console.log('  ', k, JSON.stringify(v).slice(0, 260));

fs.writeFileSync('session.json', JSON.stringify({
  savedAt: Date.now(),
  ua,
  cookies,
  idToken: auth.idToken,
  refreshToken: auth.refreshToken,
  uid: auth.uid || '',
}, null, 2));
console.log('session.json saved');
sess.close();
