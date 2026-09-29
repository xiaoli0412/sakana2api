import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUSINESS_KEY = 'business-key';
const ADMIN_KEY = 'admin-key';
const port = 24000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;

const SENSITIVE = Object.freeze({
  cookieHeader: 'cookie-header-http-boundary-sentinel',
  idToken: 'id-token-http-boundary-sentinel',
  refreshToken: 'refresh-token-http-boundary-sentinel',
  authorization: 'authorization-http-boundary-sentinel',
  cookie: 'cookie-http-boundary-sentinel',
  setCookie: 'set-cookie-http-boundary-sentinel',
  body: 'body-http-boundary-sentinel',
  prompt: 'prompt-http-boundary-sentinel',
  toolArgument: 'tool-argument-http-boundary-sentinel',
  attachment: 'attachment-http-boundary-sentinel',
  reasoning: 'reasoning-http-boundary-sentinel',
  rawUpstream: 'raw-upstream-http-boundary-sentinel',
});

const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sakana-admin-boundary-'));
const sessionFile = path.join(tempDir, 'session.json');
const poolFile = path.join(tempDir, 'account-pool.json');
const keysFile = path.join(tempDir, 'keys.json');
const savedAt = Date.now();
const sessionCookieHeader = `sakana-chat=${SENSITIVE.cookieHeader}; cf_clearance=${SENSITIVE.rawUpstream}`;
const sessionCookies = [
  { name: 'sakana-chat', value: SENSITIVE.cookieHeader, domain: 'chat.sakana.ai', path: '/' },
  { name: 'cf_clearance', value: SENSITIVE.rawUpstream, domain: 'chat.sakana.ai', path: '/' },
];
const session = {
  savedAt,
  uid: 'boundary-uid',
  email: 'boundary@example.test',
  id: 'boundary-session-id',
  cookieHeader: sessionCookieHeader,
  cookies: sessionCookies,
  idToken: SENSITIVE.idToken,
  refreshToken: SENSITIVE.refreshToken,
};
const account = {
  id: 'boundary-account-id',
  email: session.email,
  uid: session.uid,
  display: 'Boundary Account',
  state: 'active',
  successCount: 3,
  errorCount: 0,
  refreshes: 1,
  savedAt,
  cookieHeader: sessionCookieHeader,
  cookies: sessionCookies,
  idToken: SENSITIVE.idToken,
  refreshToken: SENSITIVE.refreshToken,
  modelUse: {},
  modelCount: {},
};

let child = null;
const childOutput = [];

function authHeaders(key) {
  return { authorization: `Bearer ${key}` };
}

async function request(pathname, { key, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: {
      ...(key ? authHeaders(key) : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

function assertNoSensitiveData(label, result) {
  const serialized = result.text;
  for (const [name, sentinel] of Object.entries(SENSITIVE)) {
    assert.equal(serialized.includes(sentinel), false, `${label} leaked ${name} sentinel`);
  }
  assert.doesNotMatch(serialized, /cookieHeader/i, `${label} leaked cookieHeader`);
  assert.doesNotMatch(serialized, /\bidToken\b/i, `${label} leaked idToken`);
  assert.doesNotMatch(serialized, /\brefreshToken\b/i, `${label} leaked refreshToken`);
  assert.doesNotMatch(serialized, /(?:^|[^a-z])authorization(?:[^a-z]|$)/i, `${label} leaked authorization`);
  assert.doesNotMatch(serialized, /(?:^|[^a-z])cookie(?:[^a-z]|$)/i, `${label} leaked cookie`);
  assert.doesNotMatch(serialized, /set-cookie/i, `${label} leaked set-cookie`);

  for (const [name, value] of result.response.headers) {
    assert.notEqual(name.toLowerCase(), 'set-cookie', `${label} returned set-cookie`);
    for (const [sentinelName, sentinel] of Object.entries(SENSITIVE)) {
      assert.equal(value.includes(sentinel), false, `${label} header leaked ${sentinelName} sentinel`);
    }
  }
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`server did not become ready\n${childOutput.join('')}`);
}

async function stopChild() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
  if (!stopped && child.exitCode === null) {
    const killed = once(child, 'exit');
    child.kill('SIGKILL');
    await Promise.race([killed, delay(2_000)]);
  }
}

try {
  await fs.promises.writeFile(sessionFile, JSON.stringify(session, null, 2));
  await fs.promises.writeFile(poolFile, JSON.stringify([account], null, 2));
  await fs.promises.writeFile(keysFile, '[]');

  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      AUTO_SESSION: 'false',
      HOST: '127.0.0.1',
      PORT: String(port),
      API_KEY: BUSINESS_KEY,
      ADMIN_API_KEY: ADMIN_KEY,
      SAKANA_COOKIE: 'fake-cookie=fake',
      SAKANA_SESSION_FILE: sessionFile,
      SAKANA_ACCOUNT_POOL_FILE: poolFile,
      SAKANA_KEYS_FILE: keysFile,
      CACHE_ENABLED: 'false',
      SHUTDOWN_DRAIN_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => childOutput.push(chunk.toString()));
  child.stderr.on('data', (chunk) => childOutput.push(chunk.toString()));
  child.on('error', (error) => childOutput.push(String(error)));

  await waitForServer();

  for (const key of [BUSINESS_KEY, ADMIN_KEY]) {
    const models = await request('/v1/models', { key });
    assert.equal(models.response.status, 200, `/v1/models accepts ${key}`);
    assert.equal(models.json?.object, 'list');
    assertNoSensitiveData(`/v1/models with ${key}`, models);
  }

  const rpRequest = await request('/v1/chat/completions', {
    key: BUSINESS_KEY,
    method: 'POST',
    headers: {
      cookie: `sakana-chat=${SENSITIVE.cookie}`,
      'set-cookie': SENSITIVE.setCookie,
      'x-sensitive-authorization': SENSITIVE.authorization,
    },
    body: {
      model: 'sakana-namazu-rp',
      stream: false,
      bodySentinel: SENSITIVE.body,
      prompt: SENSITIVE.prompt,
      reasoning: SENSITIVE.reasoning,
      attachment: SENSITIVE.attachment,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `${SENSITIVE.body} ${SENSITIVE.prompt} ${SENSITIVE.attachment} ${SENSITIVE.reasoning} ${SENSITIVE.rawUpstream}` },
          {
            type: 'tool_call',
            id: 'boundary-tool-call',
            function: { name: 'boundary-tool', arguments: JSON.stringify({ value: SENSITIVE.toolArgument }) },
          },
        ],
      }],
    },
  });
  assert.equal(rpRequest.response.status, 400, 'RP-disabled request is deterministic');
  assert.equal(rpRequest.json?.error?.code, 'RP-MODEL-DISABLED');
  assertNoSensitiveData('RP-disabled response', rpRequest);

  const operationalPaths = ['/api/stats', '/api/audit', '/api/export-audit.csv', '/api/accounts'];
  const adminResponses = new Map();
  for (const pathname of operationalPaths) {
    const business = await request(pathname, { key: BUSINESS_KEY });
    assert.equal(business.response.status, 403, `business key is forbidden on ${pathname}`);
    assertNoSensitiveData(`${pathname} business response`, business);

    const admin = await request(pathname, { key: ADMIN_KEY });
    assert.equal(admin.response.status, 200, `admin key is accepted on ${pathname}`);
    assertNoSensitiveData(`${pathname} admin response`, admin);
    adminResponses.set(pathname, admin);
  }

  const stats = adminResponses.get('/api/stats');
  assert.equal(typeof stats.json?.auditCount, 'number');
  assert.equal(typeof stats.json?.ops?.mem?.rssMB, 'number');

  const audit = adminResponses.get('/api/audit');
  assert.ok(Array.isArray(audit.json?.entries), 'admin audit response has entries');
  const generatedAudit = audit.json.entries.find((entry) => (
    entry.path === '/v1/chat/completions' && entry.status === 400 && entry.errorCode === 'RP-MODEL-DISABLED'
  ));
  assert.ok(generatedAudit, 'RP-disabled request created an audit entry');
  assert.equal(Object.hasOwn(generatedAudit.requestHeaders || {}, 'authorization'), false);
  assert.equal(Object.hasOwn(generatedAudit.requestHeaders || {}, 'cookie'), false);
  assert.equal(Object.hasOwn(generatedAudit.requestHeaders || {}, 'set-cookie'), false);
  assert.equal(Object.hasOwn(generatedAudit, 'body'), false);
  assert.equal(Object.hasOwn(generatedAudit, 'prompt'), false);
  assert.equal(Object.hasOwn(generatedAudit, 'reasoning'), false);

  const csv = adminResponses.get('/api/export-audit.csv');
  assert.match(csv.response.headers.get('content-type') || '', /^text\/csv/i);
  assert.match(csv.text.replace(/^\uFEFF/, ''), /^id,ts,time_iso,method,path,model,status,/);

  const accounts = adminResponses.get('/api/accounts');
  assert.ok(Array.isArray(accounts.json?.accounts), 'admin accounts response has accounts');
  const safeAccount = accounts.json.accounts.find((entry) => entry.id === account.id);
  assert.ok(safeAccount, 'seeded account is present in admin projection');
  const safeAccountFields = [
    'id', 'email', 'uid', 'display', 'state', 'inFlight', 'successCount', 'errorCount',
    'refreshes', 'savedAt', 'cookieCount', 'rateLimitedAt', 'expiredAt', 'lastRefreshAt',
    'lastError', 'lastErrorAt', 'cooldownRemainingMs', 'stale', 'leaseAgesMs', 'modelCount',
  ];
  assert.deepEqual(Object.keys(safeAccount).sort(), [...safeAccountFields].sort(), 'account projection contains safe fields only');
  assert.equal(safeAccount.email, account.email);
  assert.equal(safeAccount.uid, account.uid);
  assert.equal(safeAccount.state, 'active');
  assert.equal(safeAccount.cookieCount, sessionCookies.length);
  assert.equal(Object.hasOwn(safeAccount, 'cookieHeader'), false);
  assert.equal(Object.hasOwn(safeAccount, 'idToken'), false);
  assert.equal(Object.hasOwn(safeAccount, 'refreshToken'), false);

  console.log('admin boundary HTTP tests: all passed');
} finally {
  await stopChild();
  await fs.promises.rm(tempDir, { recursive: true, force: true });
}
