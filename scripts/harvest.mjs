#!/usr/bin/env node
// Harvest a working session (cookies + firebase tokens) from the real Chrome
// (started with --remote-debugging-port=9222) into session.json.
//
// Requires: Chrome open on chat.sakana.ai with a LOGGED-IN account.
// Steps:
//   1. waits for an authenticated page (checks /api/rate-limit/status != 401)
//   2. dumps all cookies + UA into session.json
// Usage: node scripts/harvest.mjs [--out session.json]

import fs from 'fs';
import path from 'path';
import { findPageTarget, CdpSession } from '../lib/cdp.js';

const outFile = process.argv.find((a, i) => a === '--out' && process.argv[i + 1]) ? process.argv[process.argv.indexOf('--out') + 1] : path.join(process.cwd(), 'session.json');

const target = await findPageTarget();
if (!target) { console.error('no chrome target — start Chrome with --remote-debugging-port=9222'); process.exit(1); }
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);

// 1) check login status via page fetch
const probe = await sess.evaluate(`(async () => {
  try {
    const r = await fetch('/api/rate-limit/status', { headers: { accept: 'application/json' } });
    return { status: r.status, body: (await r.text()).slice(0, 150) };
  } catch (e) { return { error: String(e) }; }
})()`);
console.log('probe /api/rate-limit/status:', JSON.stringify(probe));
if (probe.status === 401) {
  console.error('NOT LOGGED IN — please log in to chat.sakana.ai in the Chrome window (magic link), then re-run.');
  process.exit(2);
}
if (probe.status !== 200 && probe.status !== 429) {
  console.error('unexpected probe status — stopping.');
  process.exit(3);
}

const ua = await sess.evaluate('navigator.userAgent');
const cookiesRaw = await sess.send('Network.getAllCookies').then(r => r.cookies || []);
// Only chat.sakana.ai + .sakana.ai cookies matter
const cookies = cookiesRaw.filter(c => c.domain.includes('sakana.ai')).map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure }));
const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

fs.writeFileSync(outFile, JSON.stringify({ savedAt: Date.now(), ua, cookieHeader, cookies, idToken: '', refreshToken: '' }, null, 2));
console.log('saved', outFile, 'cookies:', cookies.length, 'ua:', ua.slice(0, 60) + '...');
sess.close();