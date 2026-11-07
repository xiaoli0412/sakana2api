#!/usr/bin/env node
// LIVE end-to-end test: real registration -> real proxy -> real upstream chat.
//
// Not part of `npm test` (needs the public internet, a real browser and a mail
// provider). Run manually with credentials:
//
//   SAKANA_MAIL_PROVIDER=yyds YYDS_API_KEY=... YYDS_API_BASE=... \
//     npm run test:live
//
// Or reuse an existing session (skips registration):
//   SAKANA_E2E_SESSION_FILE=./session.json npm run test:live
//
// Environments behind a TUN/fake-IP proxy resolve mail domains to 198.18/15,
// which the SSRF guard correctly rejects. For a local run only, pin real IPs:
//   SAKANA_E2E_DNS="maliapi.215.im=162.159.130.234"
//
// Exit code 0 only when every step passes; prints a JSON report.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { autoSession } = require('../lib/auto-session.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Optional DNS pin for TUN/fake-IP dev machines. Never used unless explicitly
// set; production runs resolve DNS normally and keep the SSRF guard intact.
const dnsOverride = String(process.env.SAKANA_E2E_DNS || '').trim();
if (dnsOverride) {
  const map = new Map();
  for (const pair of dnsOverride.split(',')) {
    const [host, address] = pair.split('=').map((s) => s.trim());
    if (host && address) map.set(host, address);
  }
  const original = dns.lookup;
  dns.lookup = function patchedLookup(host, options, callback) {
    if (map.has(host)) {
      if (typeof options === 'function') { callback = options; options = {}; }
      const records = [{ address: map.get(host), family: 4 }];
      if (options && options.all) return process.nextTick(() => callback(null, records));
      return process.nextTick(() => callback(null, records[0].address, 4));
    }
    return original.call(this, host, options, callback);
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sakana-live-'));
const sessionFile = path.join(tmp, 'session.json');
const port = 28000 + Math.floor(Math.random() * 1500);
const base = `http://127.0.0.1:${port}`;
const apiKey = 'e2e-business-key';
const adminKey = 'e2e-admin-key';
const results = [];
let child = null;

async function waitHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1200) });
      if (response.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

async function stopChild() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const startedAt = Date.now();
const controller = new AbortController();
const hardTimeout = setTimeout(() => controller.abort(new Error('live test timeout')), 10 * 60 * 1000);

try {
  // 1. Real registration (or reuse an explicit session file).
  let session;
  if (process.env.SAKANA_E2E_SESSION_FILE) {
    session = JSON.parse(fs.readFileSync(process.env.SAKANA_E2E_SESSION_FILE, 'utf8'));
    results.push({ step: 'register', ok: !!session.cookieHeader, mode: 'reused', uid: session.uid || '' });
  } else {
    const t0 = Date.now();
    session = await autoSession.harvestFreshIsolated({ signal: controller.signal });
    results.push({
      step: 'register',
      ok: !!(session && session.cookieHeader && session.cookies?.length),
      mode: 'fresh',
      seconds: Math.round((Date.now() - t0) / 1000),
      uid: session.uid || '',
    });
  }
  if (!session?.cookieHeader) throw new Error('no cookieHeader available');
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

  // 2. Start the proxy with that session on a throwaway port.
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      AUTO_SESSION: 'false',
      HOST: '127.0.0.1',
      PORT: String(port),
      API_KEY: apiKey,
      ADMIN_API_KEY: adminKey,
      SAKANA_SESSION_FILE: sessionFile,
      SAKANA_ACCOUNT_POOL_FILE: path.join(tmp, 'account_pool.json'),
      SAKANA_KEYS_FILE: path.join(tmp, 'keys.json'),
      SAKANA_AUDIT_FILE: path.join(tmp, 'audit-log.json'),
      CACHE_ENABLED: 'false',
      SHUTDOWN_DRAIN_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

  const ready = await waitHealth();
  results.push({ step: 'health', ok: ready, port });
  if (!ready) throw new Error(`server not ready: ${serverLog.slice(-600)}`);

  // 3. Model list.
  const modelsRes = await fetch(`${base}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  const modelsJson = await modelsRes.json();
  results.push({ step: 'models', ok: modelsRes.status === 200 && modelsJson.data?.length === 9, count: modelsJson.data?.length });

  // 4. Real non-stream chat.
  const chatRes = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'sakana',
      stream: false,
      max_tokens: 96,
      messages: [{ role: 'user', content: '只回复四个字：真实测试通过' }],
    }),
    signal: AbortSignal.timeout(180000),
  });
  const chatText = await chatRes.text();
  let chatJson = null;
  try { chatJson = JSON.parse(chatText); } catch {}
  const content = chatJson?.choices?.[0]?.message?.content || '';
  results.push({
    step: 'chat_nonstream',
    ok: chatRes.status === 200 && content.length > 0,
    status: chatRes.status,
    chars: content.length,
    sample: content.slice(0, 60),
    error: chatJson?.error?.code || null,
  });

  // 5. Real SSE stream chat.
  const streamRes = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'sakana-mini',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: '只回复两个字：流式' }],
    }),
    signal: AbortSignal.timeout(180000),
  });
  let sse = '';
  let streamed = '';
  if (streamRes.ok && streamRes.body) {
    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      sse += chunk;
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          streamed += event.choices?.[0]?.delta?.content || '';
        } catch {}
      }
      if (sse.length > 200000) break;
    }
  }
  results.push({
    step: 'chat_stream',
    ok: streamRes.status === 200 && sse.includes('data: [DONE]') && streamed.length > 0,
    status: streamRes.status,
    chars: streamed.length,
    done: sse.includes('data: [DONE]'),
  });

  // 6. Admin import of the same cookie (panel import path, end to end).
  const importRes = await fetch(`${base}/api/accounts/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ cookieHeader: session.cookieHeader }),
    signal: AbortSignal.timeout(60000),
  });
  const importJson = await importRes.json();
  results.push({
    step: 'import',
    ok: importRes.status === 200 && importJson.ok === true && typeof importJson.validation?.status === 'string',
    status: importRes.status,
    validation: importJson.validation?.status,
    format: importJson.validation?.format,
  });

  // 7. Pool projection exposes the validation without leaking cookies.
  const accountsRes = await fetch(`${base}/api/accounts`, {
    headers: { authorization: `Bearer ${adminKey}` },
    signal: AbortSignal.timeout(15000),
  });
  const accountsJson = await accountsRes.json();
  results.push({
    step: 'accounts_view',
    ok: Array.isArray(accountsJson.accounts) && accountsJson.accounts.length === 1 && typeof accountsJson.leaseCount === 'number',
    total: accountsJson.accounts?.length,
    validations: Object.keys(accountsJson.validations || {}).length,
    leaksCookie: JSON.stringify(accountsJson).includes(session.cookieHeader),
  });

  const failed = results.filter((item) => !item.ok);
  console.log('LIVE_RESULTS ' + JSON.stringify({
    total: results.length,
    failed: failed.length,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    results,
  }, null, 2));
  if (failed.length) process.exitCode = 1;
} catch (error) {
  console.log('LIVE_FAIL ' + JSON.stringify({ message: String(error.message || error).slice(0, 500) }, null, 2));
  process.exitCode = 1;
} finally {
  clearTimeout(hardTimeout);
  await stopChild();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}