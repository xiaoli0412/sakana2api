'use strict';
// Management API routes, extracted from server.js (P2 split).
//
// Everything here was moved verbatim: same URLs, same status codes, same
// error codes, same response shapes. server.js keeps the public/chat routing
// and mounts these handlers in the original order. The only structural change
// is dependency injection (stores, audit callbacks, character state) so the
// module never imports server.js.
//
// Security invariants preserved:
//   - admin endpoints require the static admin key (isAdmin), never a managed
//     business key;
//   - pool projections expose safe fields only; cookie/token sentinels never
//     leave this module's responses;
//   - import probes keep their window/backoff budget.

const fs = require('fs');
const { sendJson, readBody } = require('./http-util');
const { normalizeImportPayload } = require('./cookie-import');
const { ImportProbeGuard } = require('./import-probe-guard');
const { probeSession, probeQuota } = require('./upstream');
const { fetchRemoteJson, safeUrl: safeRemoteUrl } = require('./remote-fetch');
const { loadCard, listCards, normalizeCard, parsePngCard, saveCard } = require('./character-card');

// Manual account import (2026-10 seeding path): knobs stay env-tunable because
// this traffic sits right behind the Turnstile gate.
const IMPORT_PROBE_TIMEOUT_MS = Math.max(1000, parseInt(process.env.SAKANA_IMPORT_PROBE_TIMEOUT_MS || '15000', 10));
const IMPORT_QUOTA_PROBE = process.env.SAKANA_IMPORT_QUOTA_PROBE !== '0';
const IMPORT_QUOTA_TIMEOUT_MS = Math.max(1000, parseInt(process.env.SAKANA_IMPORT_QUOTA_TIMEOUT_MS || '10000', 10));
const IMPORT_VALIDATION_MAX = 50;

function isPublicHttpUrl(value) {
  try { safeRemoteUrl(value); return true; } catch { return false; }
}

// Harvest browser proxy is consumed by Chromium, not by our SSRF-guarded
// fetchers, so loopback proxies (127.0.0.1:7897) are legitimate here. Accept a
// scheme-qualified http/https/socks URL or a bare host:port, and nothing that
// could smuggle Chromium arguments.
function isBrowserProxy(value) {
  const raw = String(value || '').trim();
  if (!raw || /[\s'"]/.test(raw)) return false;
  if (/^[a-z0-9+.-]+:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { return false; }
    if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(url.protocol)) return false;
    return !!url.hostname && (!url.pathname || url.pathname === '/');
  }
  const m = raw.match(/^([^\s/:]+):(\d{1,5})$/);
  return !!m && Number(m[2]) > 0 && Number(m[2]) <= 65535;
}

function createAdminApi(ctx) {
  const {
    isAdmin,
    stats: statsStore,
    keyStore,
    cache: cacheStore,
    accountPool,
    autoSession,
    mailConfig,
    API_KEY = '',
    ADMIN_API_KEY = '',
    AUTO_SESSION = true,
    SESSION_FILE,
    auditLog = [],
    persistAuditLog = () => {},
    markAuditDirty = () => {},
    contextStore,
    contextTelemetry = {},
    concurrencyManager,
    CARD_DIR,
    getActiveCharacter = () => null,
    setActiveCharacter = () => {},
    errors = {},
  } = ctx;
  const { sanitizeError, clientErrorStatus, stableErrorCode } = errors;
  const importProbeGuard = new ImportProbeGuard();
  const importValidations = new Map();
  function recordImportValidation(id, entry) {
    if (!id) return;
    importValidations.set(id, entry);
    while (importValidations.size > IMPORT_VALIDATION_MAX) {
      importValidations.delete(importValidations.keys().next().value);
    }
  }

  function stats(req, res) {
    if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
    let session = null;
    try { session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch {}
    const s = statsStore.snapshot(session);
    s.cache = cacheStore.stats();
    const mem = process.memoryUsage();
    const pool = accountPool.snapshot();
    s.accounts = {
      total: pool.total,
      active: pool.active,
      limited: pool.limited,
      expired: pool.expired,
      max: pool.max,
      inFlight: pool.inFlight,
      stale: pool.stale,
      target: pool.target,
      targetMet: pool.targetMet,
      replenishing: pool.replenishing,
      refreshing: pool.refreshing,
      leaseCount: pool.leaseCount,
      oldestLeaseAgeMs: pool.oldestLeaseAgeMs,
      lastHarvestAt: pool.lastHarvestAt,
      lastHarvestErrorAt: pool.lastHarvestErrorAt,
      lastHarvestError: pool.lastHarvestError || null,
      telemetry: pool.telemetry,
    };
    s.auditCount = auditLog.length;
    s.ops = {
      concurrency: concurrencyManager.stats,
      contextCount: contextStore.size,
      uptimeSec: Math.floor((Date.now() - statsStore.startedAt) / 1000),
      mem: { rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576), heapMaxMB: Math.round(mem.heapTotal / 1048576) },
      compact: { ...contextTelemetry },
      browser: autoSession.status(),
      node: process.version,
      authMode: (API_KEY || ADMIN_API_KEY || keyStore.keys.length) ? 'keyed' : 'open',
    };
    return sendJson(res, 200, s);
  }

  async function keys(req, res) {
    if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
    if (req.method === 'GET') {
      const active = keyStore.keys.filter((k) => !k.revoked).length;
      return sendJson(res, 200, { keys: keyStore.list(), keyed: !!(API_KEY || ADMIN_API_KEY || active), open: !API_KEY && !ADMIN_API_KEY && keyStore.keys.length === 0 });
    }
    if (req.method === 'POST') {
      let b;
      try { b = JSON.parse((await readBody(req)).toString('utf8')); }
      catch (e) {
        if (req.__signal?.aborted) throw e;
        return sendJson(res, 400, { error: { message: 'invalid JSON' } });
      }
      return sendJson(res, 200, keyStore.create(b.name));
    }
    return sendJson(res, 405, { error: { message: 'method not allowed' } });
  }

  function keyAction(req, res, match) {
    if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
    const ok = match[2] === 'revoke' ? keyStore.revoke(decodeURIComponent(match[1])) : keyStore.remove(decodeURIComponent(match[1]));
    return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: { message: 'key not found' } });
  }

  function audit(req, res, p, url) {
    if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
    if (p === '/api/export-audit.csv' || url.searchParams.get('format') === 'csv') {
      const headers = ['id', 'ts', 'time_iso', 'method', 'path', 'model', 'status', 'duration_ms', 'error_code', 'error_category', 'stream', 'cache', 'request_bytes', 'response_bytes', 'context', 'request_headers', 'response_headers'];
      const csvEscape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
      const csvRows = [headers.join(',')];
      for (const e of auditLog) {
        const row = [
          e.id,
          e.ts,
          new Date(e.ts).toISOString(),
          e.method,
          e.path,
          e.model,
          e.status,
          e.duration,
          e.errorCode,
          e.errorCategory,
          e.stream,
          e.cache,
          e.requestBytes,
          e.responseBytes,
          JSON.stringify(e.context || {}),
          JSON.stringify(e.requestHeaders || {}),
          JSON.stringify(e.responseHeaders || {}),
        ].map(csvEscape);
        csvRows.push(row.join(','));
      }
      const csvStr = '\uFEFF' + csvRows.join('\r\n');
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="sakana-audit-${Date.now()}.csv"`,
        'content-length': Buffer.byteLength(csvStr),
      });
      return res.end(csvStr);
    }
    return sendJson(res, 200, { entries: auditLog.slice(0, 150) });
  }

  function auditClear(req, res) {
    if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
    auditLog.length = 0;
    markAuditDirty();
    persistAuditLog();
    return sendJson(res, 200, { ok: true });
  }

  // Accounts endpoint — ADMIN-only. Returns SAFE fields only: session cookies
  // and firebase tokens must never leave the server (any API-key holder could
  // otherwise steal and hijack the whole pool).
  function accountsList(req, res) {
    if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
    accountPool._checkCooldowns();
    const safe = accountPool.accounts.map(a => accountPool.safeAccount(a));
    const pool = accountPool.snapshot();
    // Import diagnostics: per-account validation result + live lease pressure.
    // Additive fields only; the account projection above stays unchanged.
    const validations = {};
    for (const [id, entry] of importValidations) validations[id] = entry;
    return sendJson(res, 200, {
      accounts: safe,
      total: pool.total,
      active: pool.active,
      target: pool.target,
      max: pool.max,
      lastHarvestAt: pool.lastHarvestAt,
      lastHarvestError: pool.lastHarvestError || null,
      lastHarvestErrorAt: pool.lastHarvestErrorAt,
      replenishing: pool.replenishing,
      refreshing: pool.refreshing,
      telemetry: pool.telemetry,
      persistenceError: pool.persistenceError || null,
      leaseCount: pool.leaseCount,
      inFlight: pool.inFlight,
      stale: pool.stale,
      validations,
      importProbe: importProbeGuard.snapshot(),
    });
  }

  async function accountsRefresh(req, res) {
    if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
    try {
      if (AUTO_SESSION) {
        accountPool.ensureMinPool((signal) => autoSession.harvestFresh({ signal }))
          .then((ok) => console.log(`[accounts] manual refresh harvested ${ok} accounts`))
          .catch((e) => console.log(`[accounts] manual refresh error: ${stableErrorCode(e, 500)}`));
      }
      return sendJson(res, 200, { ok: true, message: 'refresh + replenish triggered' });
    } catch (e) {
      const safe = sanitizeError(e, 500);
      return sendJson(res, clientErrorStatus(e, 500), { error: { message: safe.message, type: safe.category, code: safe.code } });
    }
  }

  // 2026-10: upstream blocks disposable-email registration (AUTH-EMAIL-001 /
  // USER_DISABLED), so automated harvest cannot create accounts anymore.
  // Admins seed the pool by importing a session cookie from a browser where
  // they signed in to chat.sakana.ai manually.
  async function accountsImport(req, res) {
    if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
    let b;
    try { b = JSON.parse((await readBody(req)).toString('utf8')); }
    catch (e) {
      if (req.__signal?.aborted) throw e;
      return sendJson(res, 400, { error: { message: 'invalid JSON' } });
    }
    // Accepts a raw Cookie header, extension JSON, Playwright storageState,
    // a cookies.txt jar or a structured cookies array; the pool always gets
    // one canonical header plus structured cookies for refreshAccount.
    const normalized = normalizeImportPayload(b);
    if (!normalized.ok) {
      return sendJson(res, 400, { error: { message: normalized.message, code: normalized.code } });
    }
    const cookieHeader = normalized.cookieHeader;

    // Probe budget: a stale cookie gets one cheap answer, but repeated
    // challenges/outages pause probing instead of hammering the Turnstile
    // gate (which would harden the challenge against this egress IP).
    const ticket = importProbeGuard.begin();
    if (!ticket.allowed) {
      const retryAfterMs = ticket.retryAfterMs;
      return sendJson(res, 429, {
        error: {
          message: `account probe temporarily paused after repeated upstream failures — retry in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s`,
          code: 'PROBE-BACKOFF',
          reason: ticket.reason,
          retryAfterMs,
        },
      });
    }
    const probe = await probeSession(cookieHeader, { timeoutMs: IMPORT_PROBE_TIMEOUT_MS })
      .catch(() => ({ ok: false, status: 0, reason: 'network_error' }));
    importProbeGuard.record({ ok: probe.ok, reason: probe.reason || (probe.ok ? 'ok' : 'network_error') });
    if (!probe.ok) {
      return sendJson(res, 400, {
        error: {
          message: `session cookie rejected by upstream (status ${probe.status}) — sign in at chat.sakana.ai and copy a fresh sakana-chat cookie`,
          code: 'SESSION-REJECTED',
          reason: probe.reason || 'invalid_session',
          upstreamStatus: probe.status,
          retryAfterMs: probe.retryAfterMs || 0,
        },
      });
    }
    // Quota snapshot (protocol.md §6b): tells the operator whether a live
    // cookie is already day/week-capped before it occupies a pool slot.
    // SAKANA_IMPORT_QUOTA_PROBE=0 skips this second upstream request.
    let quota = null;
    if (IMPORT_QUOTA_PROBE) {
      quota = await probeQuota(cookieHeader, { timeoutMs: IMPORT_QUOTA_TIMEOUT_MS }).catch(() => null);
    }
    const id = accountPool.upsert({
      cookieHeader,
      cookies: normalized.cookies,
      savedAt: Date.now(),
      loggedIn: true,
      uid: normalized.uid,
      email: normalized.email,
    });
    if (!id) {
      return sendJson(res, 409, { error: { message: 'session already in pool or pool entry quarantined', code: 'DUPLICATE-SESSION' } });
    }
    const validation = {
      status: quota && Array.isArray(quota.exceeded) && quota.exceeded.length ? 'quota_exhausted' : 'active',
      reason: 'ok',
      checkedAt: Date.now(),
      upstreamStatus: probe.status,
      format: normalized.format,
      cookieCount: normalized.cookieCount,
      quota: quota ? {
        ok: !!quota.ok,
        status: quota.status,
        models: quota.models || [],
        exceeded: quota.exceeded || [],
      } : null,
    };
    recordImportValidation(id, validation);
    console.log(`[accounts] imported session cookie via admin (format ${normalized.format}, pool size ${accountPool.count()})`);
    return sendJson(res, 200, { ok: true, id, poolSize: accountPool.count(), validation });
  }

  function cacheClear(req, res) {
    if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
    cacheStore.clear();
    return sendJson(res, 200, { ok: true, stats: cacheStore.stats() });
  }

  // Mail provider config (YYDS / mailtm) — panel-configurable, runtime-effective.
  async function mailConfigRoute(req, res) {
    if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
    if (req.method === 'GET') {
      const saved = mailConfig.readMailConfig();
      const provider = saved.provider || process.env.SAKANA_MAIL_PROVIDER || (process.env.YYDS_API_KEY ? 'yyds' : 'mailtm');
      const key = saved.apiKey || process.env.YYDS_API_KEY || '';
      return sendJson(res, 200, {
        provider,
        apiBase: saved.apiBase || process.env.YYDS_API_BASE || 'https://maliapi.215.im/v1',
        domain: saved.domain || process.env.YYDS_DOMAIN || '',
        hasKey: !!key,
        keyPreview: key ? key.slice(0, 10) + '…' : null,
        // Cloudflare Worker provider fields + harvest browser proxy
        cfBase: saved.cfBase || process.env.CF_MAIL_BASE || '',
        cfDomain: saved.cfDomain || process.env.CF_MAIL_DOMAIN || '',
        cfHasKey: !!(saved.cfApiKey || process.env.CF_MAIL_API_KEY),
        browserProxy: saved.browserProxy !== undefined ? saved.browserProxy
          : (process.env.SAKANA_BROWSER_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''),
      });
    }
    if (req.method === 'POST') {
      let b;
      try { b = JSON.parse((await readBody(req)).toString('utf8')); }
      catch (e) {
        if (req.__signal?.aborted) throw e;
        return sendJson(res, 400, { error: { message: 'invalid JSON' } });
      }
      const provider = String(b?.provider || '').toLowerCase();
      if (!['yyds', 'mailtm', 'cloudflare'].includes(provider)) {
        return sendJson(res, 400, { error: { message: 'provider must be yyds, mailtm or cloudflare' } });
      }
      const saved = mailConfig.readMailConfig();
      const next = {
        provider,
        apiKey: b.apiKey ? String(b.apiKey) : (saved.apiKey || process.env.YYDS_API_KEY || ''),
        apiBase: b.apiBase ? String(b.apiBase) : (saved.apiBase || process.env.YYDS_API_BASE || 'https://maliapi.215.im/v1'),
        domain: b.domain !== undefined ? String(b.domain) : (saved.domain || process.env.YYDS_DOMAIN || ''),
        cfBase: b.cfBase ? String(b.cfBase).replace(/\/+$/, '') : (saved.cfBase || process.env.CF_MAIL_BASE || ''),
        cfDomain: b.cfDomain !== undefined ? String(b.cfDomain) : (saved.cfDomain || process.env.CF_MAIL_DOMAIN || ''),
        cfApiKey: b.cfApiKey ? String(b.cfApiKey) : (saved.cfApiKey || process.env.CF_MAIL_API_KEY || ''),
        browserProxy: b.browserProxy !== undefined ? String(b.browserProxy) : (saved.browserProxy || ''),
      };
      if (provider === 'yyds' && !next.apiKey) {
        return sendJson(res, 400, { error: { message: 'YYDS provider requires an API key (AC-…)' } });
      }
      if (provider === 'cloudflare' && !next.cfBase) {
        return sendJson(res, 400, { error: { message: 'cloudflare provider requires a Worker API Base (如 https://apimail.example.com)' } });
      }
      if (!isPublicHttpUrl(next.apiBase)) {
        return sendJson(res, 400, { error: { message: 'apiBase must be a public http(s) URL' } });
      }
      if (next.cfBase && !isPublicHttpUrl(next.cfBase)) {
        return sendJson(res, 400, { error: { message: 'cfBase must be a public http(s) URL' } });
      }
      // The proxy is handed straight to Chromium, so accept only what
      // Playwright accepts: an http(s)/socks URL, or host:port.
      if (next.browserProxy && !isBrowserProxy(next.browserProxy)) {
        return sendJson(res, 400, { error: { message: 'browserProxy must be an http(s)/socks proxy URL or host:port' } });
      }
      let verified = false;
      if (provider === 'yyds' && next.apiKey) {
        let result;
        try {
          result = await fetchRemoteJson(new URL('/me', next.apiBase).href, {
            headers: { 'X-API-Key': next.apiKey },
            signal: req.__signal,
            maxBytes: 256 * 1024,
          });
        } catch {}
        verified = !!result?.ok;
      } else if (provider === 'cloudflare') {
        // Prove the full path works by creating a disposable mailbox; the
        // worker must be reached DIRECTLY (it 403s through a proxy), so this
        // intentionally uses the global no-proxy dispatcher.
        try {
          const probe = await fetchRemoteJson(next.cfBase + '/api/new_address', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(next.cfApiKey ? { 'x-custom-auth': next.cfApiKey, 'x-api-key': next.cfApiKey } : {}) },
            body: JSON.stringify(next.cfDomain ? { name: 'probe' + Date.now().toString(36), domain: next.cfDomain } : { name: 'probe' + Date.now().toString(36) }),
            signal: req.__signal,
            maxBytes: 256 * 1024,
          });
          verified = !!(probe?.ok && (probe.body?.address));
        } catch {}
      }
      mailConfig.saveMailConfig(next);
      console.log(`[mail-config] provider=${provider} domain=${next.domain || next.cfDomain || '(rotate)'} proxy=${next.browserProxy || '(env/direct)'} verified=${verified}`);
      return sendJson(res, 200, { ok: true, verified, provider: next.provider, domain: next.domain || next.cfDomain });
    }
    return sendJson(res, 405, { error: { message: 'method not allowed' } });
  }

  async function mailConfigTest(req, res) {
    if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
    const provider = process.env.SAKANA_MAIL_PROVIDER || (process.env.YYDS_API_KEY ? 'yyds' : 'mailtm');
    if (provider === 'cloudflare') {
      const cfBase = (process.env.CF_MAIL_BASE || '').replace(/\/+$/, '');
      if (!cfBase) return sendJson(res, 400, { error: { message: 'CF_MAIL_BASE not configured' } });
      if (!isPublicHttpUrl(cfBase)) return sendJson(res, 400, { error: { message: 'CF_MAIL_BASE must be a public http(s) URL' } });
      try {
        const headers = { 'content-type': 'application/json', origin: cfBase, referer: cfBase + '/' };
        if (process.env.CF_MAIL_API_KEY) {
          headers['x-custom-auth'] = process.env.CF_MAIL_API_KEY;
          headers['x-api-key'] = process.env.CF_MAIL_API_KEY;
        }
        const result = await fetchRemoteJson(cfBase + '/api/new_address', {
          method: 'POST',
          headers,
          body: JSON.stringify(process.env.CF_MAIL_DOMAIN ? { name: 'probe' + Date.now().toString(36), domain: process.env.CF_MAIL_DOMAIN } : { name: 'probe' + Date.now().toString(36) }),
          signal: AbortSignal.any([req.__signal, AbortSignal.timeout(15000)].filter(Boolean)),
          maxBytes: 256 * 1024,
        });
        const addr = result.body && result.body.address;
        if (!result.ok || !addr) return sendJson(res, 200, { ok: false, message: `worker 返回 HTTP ${result.status}` });
        return sendJson(res, 200, { ok: true, detail: `Cloudflare Worker 正常 · 测试邮箱 ${addr}` });
      } catch (e) {
        return sendJson(res, 200, { ok: false, message: 'network error（注意：邮箱 Worker 必须直连，不能挂代理）' });
      }
    }
    if (provider !== 'yyds') return sendJson(res, 200, { ok: provider === 'mailtm', detail: provider === 'mailtm' ? 'mail.tm 无需 key(域名大概率已被上游封禁)' : 'provider not yyds' });
    if (!process.env.YYDS_API_KEY) return sendJson(res, 400, { error: { message: 'YYDS_API_KEY not configured' } });
    try {
      const apiBase = process.env.YYDS_API_BASE || 'https://maliapi.215.im/v1';
      if (!isPublicHttpUrl(apiBase)) return sendJson(res, 400, { error: { message: 'YYDS_API_BASE must be a public http(s) URL' } });
      const result = await fetchRemoteJson(new URL('/me', apiBase).href, {
        headers: { 'X-API-Key': process.env.YYDS_API_KEY },
        signal: AbortSignal.any([req.__signal, AbortSignal.timeout(15000)].filter(Boolean)),
        maxBytes: 256 * 1024,
      });
      if (!result.ok) return sendJson(res, 200, { ok: false, message: `上游返回 HTTP ${result.status}` });
      return sendJson(res, 200, { ok: true, detail: 'YYDS connection healthy' });
    } catch (e) {
      return sendJson(res, 200, { ok: false, message: 'network error' });
    }
  }

  // Character card management
  async function characters(req, res, p) {
    // The avatar is served publicly before the auth gate (see server.js).
    if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
    // POST /api/characters/upload — upload a PNG character card
    if (req.method === 'POST' && p === '/api/characters/upload') {
      try {
        const raw = await readBody(req);
        const parsed = parsePngCard(raw);
        const card = normalizeCard(parsed.json, parsed.spec);
        const record = saveCard(CARD_DIR, card, parsed.png);
        console.log('[character-card] uploaded:', record.name);
        return sendJson(res, 200, { id: record.id, name: record.name, description: (record.description || '').slice(0, 100) });
      } catch (e) {
        if (req.__signal?.aborted) throw e;
        const safe = sanitizeError(e, 400);
        return sendJson(res, 400, { error: { message: safe.message, type: 'invalid_character_card', code: safe.code } });
      }
    }
    // GET /api/characters — list all cards
    if (req.method === 'GET' && p === '/api/characters') {
      const cards = listCards(CARD_DIR);
      const activeCharacter = getActiveCharacter();
      return sendJson(res, 200, { characters: cards, active: activeCharacter ? { id: activeCharacter.id, name: activeCharacter.name } : null });
    }
    // GET /api/characters/active — get active character info
    if (req.method === 'GET' && p === '/api/characters/active') {
      const activeCharacter = getActiveCharacter();
      return sendJson(res, 200, { character: activeCharacter ? { id: activeCharacter.id, name: activeCharacter.name } : null });
    }
    // POST /api/characters/deactivate — clear active character
    if (req.method === 'POST' && p === '/api/characters/deactivate') {
      setActiveCharacter(null);
      return sendJson(res, 200, { ok: true });
    }
    // POST /api/characters/:id/activate — set a specific card as active
    if (req.method === 'POST' && p.endsWith('/activate') && p.length > 22) {
      const id = decodeURIComponent(p.slice('/api/characters/'.length, -'/activate'.length));
      const card = loadCard(CARD_DIR, id);
      if (!card) return sendJson(res, 404, { error: { message: 'character not found' } });
      setActiveCharacter(card);
      return sendJson(res, 200, { ok: true, id: card.id, name: card.name });
    }
    return sendJson(res, 404, { error: { message: 'not found: ' + p, type: 'invalid_request_error' } });
  }

  return {
    stats, keys, keyAction, audit, auditClear,
    accountsList, accountsRefresh, accountsImport,
    cacheClear, mailConfig: mailConfigRoute, mailConfigTest, characters,
  };
}

module.exports = { createAdminApi, isPublicHttpUrl, isBrowserProxy };