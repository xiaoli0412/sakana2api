import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
// Poll with short per-step evaluate returning {done, out}
for (let i = 0; i < 30; i++) {
  const state = await sess.evaluate(`(() => {
    try {
      const req = indexedDB.open('firebaseLocalStorageDb');
      let result = { phase: 'opening' };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('firebaseLocalStorage', 'readonly');
        const store = tx.objectStore('firebaseLocalStorage');
        const g = store.getAll();
        g.onsuccess = () => {
          const rows = (g.result || []);
          window.__fbPoll = { rows: rows.length, hasIdToken: rows.some(r => r && r.value && r.value.idToken), keys: rows.map(r => r.fbase_key) };
        };
      };
      // give it a beat via promise race
      return new Promise((resolve) => {
        setTimeout(() => {
          if (window.__fbPoll) resolve({ phase: 'done', ...window.__fbPoll });
          else resolve({ phase: 'idle' });
        }, 600);
      });
    } catch (e) { return { phase: 'err', error: String(e) }; }
  })()`);
  console.log(i, JSON.stringify(state));
  if (state.phase === 'done' && state.hasIdToken) break;
  await new Promise(r => setTimeout(r, 1500));
}
sess.close();
