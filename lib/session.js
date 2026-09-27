// Session manager: keeps the cookie jar + UA needed by upstream.
// Sources:
//   1. session.json written by scripts/harvest.mjs (real browser login)
//   2. SAKANA_COOKIE / SAKANA_UA env fallback
// Refreshes cf_clearance proactively when it gets old (re-harvest hook optional).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_FILE = process.env.SAKANA_SESSION_FILE || path.join(__dirname, '..', 'session.json');

function atomicWriteSession(value) {
  const tmp = `${SESSION_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, SESSION_FILE);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

let session = null;
let loadError = null;
let onReload = null; // async callback to refresh session (browser-based) - optional
let reloadPromise = null;

function loadSession() {
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    const j = JSON.parse(raw);
    session = {
      cookieHeader: Array.isArray(j.cookies)
        ? j.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
        : (j.cookieHeader || ''),
      ua: j.ua || process.env.SAKANA_UA || '',
      savedAt: j.savedAt || Date.now(),
      uid: j.uid || '',
      email: j.email || '',
      id: j.id || '',
      idToken: j.idToken || '',
      refreshToken: j.refreshToken || '',
    };
    // env cookie overrides
    if (process.env.SAKANA_COOKIE) session.cookieHeader = process.env.SAKANA_COOKIE;
    loadError = null;
  } catch (e) {
    loadError = e.message;
    session = {
      cookieHeader: process.env.SAKANA_COOKIE || '',
      ua: process.env.SAKANA_UA || '',
    };
  }
  return session;
}

async function getSession() {
  if (!session) loadSession();
  if (loadError && !session?.cookieHeader) throw new Error('No session: ' + loadError + ' — run scripts/harvest.mjs or set SAKANA_COOKIE');
  // Refresh before cf_clearance age > 25 min. Share one in-flight reload and
  // re-check freshness after waiting so concurrent callers do not serialize
  // duplicate browser refreshes.
  const isStale = () => (Date.now() - (session?.savedAt || 0)) / 60000 > 25;
  if (isStale() && onReload) {
    if (!reloadPromise) {
      reloadPromise = (async () => {
        if (!isStale()) return session;
        const fresh = await onReload();
        if (fresh) {
          session = fresh;
          atomicWriteSession({ ...session, savedAt: Date.now() });
        }
        return session;
      })().finally(() => { reloadPromise = null; });
    }
    try { await reloadPromise; } catch (e) { /* keep old session */ }
  }
  return session;
}

function setReloadHandler(fn) { onReload = fn; }

module.exports = { getSession, loadSession, setReloadHandler, SESSION_FILE };