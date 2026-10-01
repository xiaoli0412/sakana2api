// Optional Rust (napi-rs) acceleration for CPU-bound hot paths.
// Loads native/index.node when built (scripts/build-native.mjs); every
// exported function has a byte-exact JS fallback so the server never depends
// on the binary being present. SAKANA_NATIVE=0 forces the fallback.
const crypto = require('crypto');

let native = null;
if (process.env.SAKANA_NATIVE !== '0') {
  try {
    native = require('../native/index.node');
  } catch {
    native = null;
  }
}

function jsSha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function jsUtf8ClampBytes(input, maxBytes) {
  const s = String(input ?? '');
  const limit = Math.max(0, maxBytes | 0);
  if (Buffer.byteLength(s, 'utf8') <= limit) return s;
  const buf = Buffer.from(s, 'utf8');
  let end = limit;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

function sha256Hex(buf) {
  if (native && typeof native.sha256Hex === 'function') return native.sha256Hex(buf);
  return jsSha256Hex(buf);
}

function utf8ClampBytes(input, maxBytes) {
  if (native && typeof native.utf8ClampBytes === 'function') return native.utf8ClampBytes(input, maxBytes);
  return jsUtf8ClampBytes(input, maxBytes);
}

module.exports = {
  sha256Hex,
  utf8ClampBytes,
  jsSha256Hex,
  jsUtf8ClampBytes,
  available: !!native,
  version: native && typeof native.nativeVersion === 'function' ? native.nativeVersion() : null,
};
