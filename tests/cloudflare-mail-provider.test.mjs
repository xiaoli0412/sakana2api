// Regression coverage for the Cloudflare Worker mail provider and the pinned
// harvest-browser proxy. No network access: mail bodies are literals and the
// proxy assertions read the launch options only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { autoSession } = require('../lib/auto-session.js');
const { linkFromMailBody, browserLaunchOptions } = autoSession.__testing;

const LINK = 'https://sakana-talk.firebaseapp.com/__/auth/action?apiKey=AIzaSyTEST&mode=signIn&oobCode=OOBC-1_2&continueUrl=https%3A%2F%2Fchat.sakana.ai%2F&lang=en';
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
const htmlBody = (link) => `<html><body><a href="${link.replace(/&/g, '&amp;')}">Sign in</a></body></html>`;

test('linkFromMailBody keeps plain HTML behaviour for yyds/mailtm', () => {
  assert.equal(linkFromMailBody(htmlBody(LINK)), LINK);
  assert.equal(linkFromMailBody('no link in here'), '');
});

test('linkFromMailBody stops at the closing quote of an href', () => {
  assert.equal(linkFromMailBody(`<a href="${LINK}">go</a>`), LINK);
});

test('linkFromMailBody rejoins soft-wrapped base64 RFC822 parts', () => {
  const raw = [
    'From: noreply@sakana.ai',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(htmlBody(LINK)),
  ].join('\r\n');
  assert.equal(linkFromMailBody(raw), LINK);
});

test('linkFromMailBody unwraps quoted-printable soft line breaks', () => {
  const escaped = htmlBody(LINK).replace(/=/g, '=3D').replace(/&/g, '=26');
  const wrapped = escaped.match(/.{1,60}/g).join('=\r\n');
  assert.equal(linkFromMailBody('Content-Transfer-Encoding: quoted-printable\r\n\r\n' + wrapped), LINK);
});

test('linkFromMailBody does not corrupt percent-encoded values in the link', () => {
  const withPct = 'https://sakana-talk.firebaseapp.com/__/auth/action?apiKey=K&continueUrl=https%3A%2F%2Fx%2F%3Dtest';
  assert.equal(linkFromMailBody(withPct), withPct);
});

test('browserLaunchOptions pins SAKANA_BROWSER_PROXY at launch time', (t) => {
  const saved = { SAKANA_BROWSER_PROXY: process.env.SAKANA_BROWSER_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;

  process.env.SAKANA_BROWSER_PROXY = 'http://127.0.0.1:7897';
  assert.deepEqual(browserLaunchOptions({ headless: true }).proxy, { server: 'http://127.0.0.1:7897' });

  // An empty panel value must fall through to the env proxies, not force direct.
  process.env.SAKANA_BROWSER_PROXY = '';
  assert.equal(browserLaunchOptions({ headless: true }).proxy, undefined);
  process.env.HTTPS_PROXY = 'http://env-proxy:8080';
  assert.deepEqual(browserLaunchOptions({ headless: true }).proxy, { server: 'http://env-proxy:8080' });

  // A panel value wins over the environment.
  process.env.SAKANA_BROWSER_PROXY = 'socks5://127.0.0.1:1080';
  assert.deepEqual(browserLaunchOptions({ headless: true }).proxy, { server: 'socks5://127.0.0.1:1080' });
});

console.log('cloudflare mail provider tests: all passed');
