use napi::bindgen_prelude::*;
use napi_derive::napi;
use sha2::{Digest, Sha256};

/// SHA-256 hex digest over raw bytes. Hot path: attachment integrity digests
/// for multi-megabyte context documents (was crypto.createHash in JS).
#[napi]
pub fn sha256_hex(input: Buffer) -> String {
  let mut hasher = Sha256::new();
  hasher.update(input.as_ref());
  let out = hasher.finalize();
  let mut s = String::with_capacity(64);
  for b in out.iter() {
    s.push_str(&format!("{:02x}", b));
  }
  s
}

/// Byte-budget clamp that never splits a UTF-8 code point.
/// Mirrors the JS byte-safe clipping used before upstream payload assembly.
#[napi]
pub fn utf8_clamp_bytes(input: String, max_bytes: u32) -> String {
  let limit = max_bytes as usize;
  if input.len() <= limit {
    return input;
  }
  let mut end = limit;
  while end > 0 && !input.is_char_boundary(end) {
    end -= 1;
  }
  input[..end].to_string()
}

#[napi]
pub fn native_version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}
