// Session manager: keeps the cookie jar + UA needed by upstream.
// Sources:
//   1. session.json written by scripts/harvest.mjs (real browser login)
//   2. SAKANA_COOKIE / SAKANA_UA env fallback
// Refreshes cf_clearance proactively when it gets old (re-harvest hook optional).

const fs = require('fs');
const path = require('path');

const SESSION_FILE = process.env.SAKANA_SESSION_FILE || path.join(__dirname, '..', 'session.json');

let session = null;
let loadError = null;
let onReload = null; // async callback to refresh session (browser-based) - optional

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
  if (loadError) throw new Error('No session: ' + loadError + ' — run scripts/harvest.mjs or set SAKANA_COOKIE');
  // refresh before cf_clearance age > 25 min
  const ageMin = (Date.now() - (session.savedAt || 0)) / 60000;
  if (ageMin > 25 && onReload) {
    try {
      const fresh = await onReload();
      if (fresh) {
        session = fresh;
        fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...session, savedAt: Date.now() }, null, 2));
      }
    } catch (e) { /* keep old session */ }
  }
  return session;
}

function setReloadHandler(fn) { onReload = fn; }

module.exports = { getSession, loadSession, setReloadHandler, SESSION_FILE };