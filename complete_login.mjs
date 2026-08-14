import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

// 1) Check current auth state in IndexedDB
const st = await sess.evaluate(`(async () => {
  const req = indexedDB.open('firebaseLocalStorageDb');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const tx = db.transaction('firebaseLocalStorage', 'readonly');
  const store = tx.objectStore('firebaseLocalStorage');
  const rows = await new Promise((res, rej) => { const g = store.getAll(); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
  return rows.map(r => ({ key: r.fbase_key, isAnon: r.value && r.value.isAnonymous, uid: r.value && r.value.uid, email: r.value && r.value.email }));
})()`);
console.log('auth state:', JSON.stringify(st));

// 2) Try the API now from page context
const probe = await sess.evaluate(`(async () => {
  const r = await fetch('/api/rate-limit/status', { headers: { accept: 'application/json' } });
  return { status: r.status, body: (await r.text()).slice(0, 120) };
})()`);
console.log('api probe:', JSON.stringify(probe));
sess.close();
