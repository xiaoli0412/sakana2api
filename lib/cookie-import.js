'use strict';
// Admin account-import payload normalizer.
//
// 2026-10: upstream blocks disposable-email registration, so the only way to
// refill the pool is an operator pasting a session cookie exported from a real
// browser. Browser cookie extensions, Playwright and curl each export a
// different shape; normalize all of them into the canonical
// {cookieHeader, cookies} pair the pool already stores.
//
// Accepted inputs:
//   {"cookieHeader":"sakana-chat=...; cf_clearance=..."}   raw Cookie header
//   {"cookieHeader":"Cookie: sakana-chat=..."}             curl copy-paste
//   {"cookieHeader":"[{name,value,...}]"}                  Cookie-Editor / EditThisCookie JSON
//   {"cookieHeader":"{\"cookies\":[...]}"}                 Playwright storageState JSON
//   {"cookieHeader":"# Netscape HTTP Cookie File\n..."}    curl / yt-dlp cookie jar
//   {"cookies":[{name,value,domain,path}]}                 structured export
//
// Callers must never log the returned values: the cookie header is a live
// session credential. This module is pure and never throws.

const MAX_INPUT_CHARS = 32 * 1024;
const MAX_COOKIES = 64;
const MAX_NAME_CHARS = 256;
const MAX_VALUE_CHARS = 4096;
const DEFAULT_DOMAIN = 'chat.sakana.ai';
// RFC 6265 token characters; a cookie name outside this set is not a cookie.
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Header values cannot carry controls; CR/LF here would be header injection.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// Upstream egress is origin-pinned to chat.sakana.ai; unrelated cookie domains
// are dropped from the metadata rather than stored.
const SAKANA_DOMAIN_RE = /^(?:\.)?(?:[a-z0-9-]+\.)*sakana\.ai$/i;

function failure(message, code = 'INVALID-SESSION') {
  return { ok: false, code, message };
}

function cleanString(value, max) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

/** Accepts [{name,value}] or ["name=value"] entries; returns null on garbage. */
function entriesFromList(list) {
  if (!Array.isArray(list)) return null;
  const entries = [];
  for (const item of list.slice(0, 512)) {
    if (!item) continue;
    if (typeof item === 'string') {
      const eq = item.indexOf('=');
      if (eq <= 0) return null;
      entries.push({ name: item.slice(0, eq).trim(), value: item.slice(eq + 1) });
      continue;
    }
    if (typeof item !== 'object') continue;
    const name = cleanString(item.name ?? item.Name, MAX_NAME_CHARS).trim();
    const value = cleanString(item.value ?? item.Value, MAX_VALUE_CHARS);
    if (!name) continue;
    entries.push({
      name,
      value,
      domain: cleanString(item.domain ?? item.Domain, 255),
      path: cleanString(item.path ?? item.Path, 255),
    });
  }
  return entries.length ? entries : null;
}

/**
 * Raw `Cookie:` header text. `document.cookie`, browser devtools and curl all
 * produce this shape (`a=b; c=d`, optionally prefixed by `Cookie:`).
 */
function entriesFromHeader(text) {
  const body = text.replace(/^cookie\s*[:：]\s*/i, '').trim();
  if (!body) return null;
  const entries = [];
  for (const part of body.split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) return null;
    entries.push({ name: piece.slice(0, eq).trim(), value: piece.slice(eq + 1) });
  }
  return entries.length ? entries : null;
}

/** JSON export: storageState `{cookies:[...]}`, extension array, or one object. */
function entriesFromJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (Array.isArray(parsed)) return entriesFromList(parsed);
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.cookies)) return entriesFromList(parsed.cookies);
    if (parsed.name && parsed.value !== undefined) return entriesFromList([parsed]);
    if (typeof parsed.cookieHeader === 'string') return entriesFromHeader(parsed.cookieHeader);
    if (typeof parsed.cookie === 'string') return entriesFromHeader(parsed.cookie);
  }
  return null;
}

/** Netscape cookie jar: 7 tab-separated fields, `#` comments ignored. */
function entriesFromNetscape(text) {
  const entries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = rawLine.split('\t');
    if (fields.length < 7) continue;
    const name = fields[5].trim();
    const value = fields[6].trim();
    if (!name) continue;
    entries.push({ name, value, domain: fields[0].trim(), path: fields[2].trim() || '/' });
  }
  return entries.length ? entries : null;
}

function normalizeEntries(entries) {
  const byName = new Map();
  for (const entry of entries) {
    if (byName.size >= MAX_COOKIES) break;
    const name = entry.name;
    if (!name || name.length > MAX_NAME_CHARS || !TOKEN_RE.test(name)) {
      return { error: `invalid cookie name in import payload` };
    }
    const value = entry.value;
    if (value.length > MAX_VALUE_CHARS) return { error: 'cookie value is too long' };
    // Cookie values may contain '=' and most punctuation, but never controls.
    if (CONTROL_RE.test(value)) return { error: 'cookie value contains invalid control characters' };
    if (CONTROL_RE.test(name)) return { error: 'cookie name contains invalid control characters' };
    // A browser export carries cookies for every site; egress is pinned to
    // chat.sakana.ai, so unrelated domains are dropped rather than forwarded.
    const rawDomain = (entry.domain || '').trim();
    if (rawDomain && !SAKANA_DOMAIN_RE.test(rawDomain)) continue;
    const domain = rawDomain || DEFAULT_DOMAIN;
    const path = entry.path && entry.path.startsWith('/') ? entry.path : '/';
    byName.set(name, { name, value, domain, path });
  }
  return { cookies: [...byName.values()] };
}

/**
 * Normalize an admin import body.
 * Returns {ok:true, format, cookieHeader, cookies, uid, email} or
 * {ok:false, code:'INVALID-SESSION', message}.
 */
function normalizeImportPayload(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  let text = '';
  if (typeof input.cookieHeader === 'string') text = input.cookieHeader;
  else if (typeof input.cookie === 'string') text = input.cookie;
  else if (typeof input.rawCookie === 'string') text = input.rawCookie;

  text = text.replace(/^\uFEFF/, '').trim();
  if (text.length > MAX_INPUT_CHARS) {
    return failure(`cookie input is too large (${MAX_INPUT_CHARS} characters max)`);
  }

  let entries = null;
  let format = 'header';
  if (text) {
    if (text.startsWith('[') || text.startsWith('{')) {
      entries = entriesFromJson(text);
      format = 'json';
      if (!entries) return failure('could not parse the cookie JSON export — expected a cookie array or a Playwright storageState object');
    } else if (/^cookie\s*[:：]/i.test(text)) {
      entries = entriesFromHeader(text);
      format = 'header';
    } else if (/^#\s*Netscape HTTP Cookie File/i.test(text) || (text.includes('\t') && /^[^\t]+\t(?:TRUE|FALSE)\t/i.test(text))) {
      entries = entriesFromNetscape(text);
      format = 'cookies.txt';
      if (!entries) return failure('could not parse the cookies.txt export');
    } else {
      entries = entriesFromHeader(text);
      format = 'header';
    }
    if (!entries) return failure('could not parse the cookie input');
  } else if (Array.isArray(input.cookies) && input.cookies.length) {
    entries = entriesFromList(input.cookies);
    format = 'cookies';
    if (!entries) return failure('could not parse the cookies array');
  }

  if (!entries || !entries.length) {
    return failure('cookieHeader must contain a sakana-chat cookie');
  }

  const normalized = normalizeEntries(entries);
  if (normalized.error) return failure(normalized.error);

  const cookies = normalized.cookies;
  const hasSakanaChat = cookies.some(c => c.name === 'sakana-chat' && c.value);
  if (!hasSakanaChat) {
    return failure('cookieHeader must contain a sakana-chat cookie');
  }

  return {
    ok: true,
    format,
    cookieHeader: cookies.map(c => `${c.name}=${c.value}`).join('; '),
    cookies,
    cookieCount: cookies.length,
    uid: cleanString(input.uid, 256).trim(),
    email: cleanString(input.email, 320).trim(),
  };
}

module.exports = { normalizeImportPayload, MAX_INPUT_CHARS };