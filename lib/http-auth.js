'use strict';
// Three-state request authentication, extracted from server.js (P2).
//
// Modes (see README 鉴权模式):
//   open   — no API_KEY, no ADMIN_API_KEY, no managed keys: everything allowed
//   keyed  — any configured secret: /v1/* needs a valid business/admin key
//   locked — admin endpoints need the static ADMIN_API_KEY only
//
// Managed API keys are business credentials; they must never grant admin
// access to pool/audit/persistence endpoints. This module captures the static
// config once, like server.js did, and reads the live KeyStore each request.

/**
 * Multi-format token extraction: Authorization: Bearer / x-goog-api-key /
 * goog-api-key / x-api-key / api-key, plus Gemini's ?key= query parameter.
 */
function extractToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const key = req.headers['x-goog-api-key'] || req.headers['goog-api-key'] ||
    req.headers['x-api-key'] || req.headers['api-key'];
  if (key) return key;
  try {
    const q = new URL(req.url, 'http://x').searchParams.get('key');
    if (q) return q;
  } catch {}
  return '';
}

function createAuth({ apiKey = '', adminKey = '', keyStore }) {
  if (!keyStore) throw new Error('createAuth requires a keyStore');

  function auth(req) {
    const activeKeys = keyStore.keys.filter((k) => !k.revoked).length;
    if (!apiKey && !adminKey && activeKeys === 0 && keyStore.keys.length === 0) return true;
    const tok = extractToken(req);
    if (apiKey && tok === apiKey) return true;
    if (adminKey && tok === adminKey) return true;
    const key = keyStore.validate(tok);
    if (key) { req.keyId = key.id; req.keyName = key.name; return true; }
    return false;
  }

  function isAdmin(req) {
    const activeKeys = keyStore.keys.filter((k) => !k.revoked).length;
    if (!adminKey && activeKeys === 0 && keyStore.keys.length === 0) return true;
    const tok = extractToken(req);
    // Managed API keys are for business endpoints only. Operational metadata and
    // key management require the explicitly configured static admin secret.
    return !!adminKey && tok === adminKey;
  }

  return { auth, isAdmin, extractToken };
}

module.exports = { createAuth, extractToken };