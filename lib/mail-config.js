// Mail provider configuration persisted in the runtime dir (survives deploys
// and restarts) and applied to process.env at boot. auto-session reads the
// env at call time, so panel changes take effect without a restart.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAIL_CONFIG_FILE = process.env.SAKANA_MAIL_CONFIG_FILE
  || path.join(__dirname, '..', 'runtime', 'mail-config.json');

function readMailConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(MAIL_CONFIG_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function applyMailConfig(cfg) {
  if (!cfg) return;
  if (cfg.provider) process.env.SAKANA_MAIL_PROVIDER = cfg.provider;
  if (cfg.apiKey) process.env.YYDS_API_KEY = cfg.apiKey;
  if (cfg.apiBase) process.env.YYDS_API_BASE = cfg.apiBase;
  if (cfg.domain !== undefined) process.env.YYDS_DOMAIN = cfg.domain || '';
  // Cloudflare Worker mail provider (cloudflare_temp_email style) — same panel,
  // same runtime persistence; auto-session reads these env vars at call time.
  if (cfg.cfBase) process.env.CF_MAIL_BASE = cfg.cfBase;
  if (cfg.cfDomain !== undefined) process.env.CF_MAIL_DOMAIN = cfg.cfDomain || '';
  if (cfg.cfPrefix) process.env.CF_MAIL_PREFIX = cfg.cfPrefix;
  if (cfg.cfApiKey !== undefined) process.env.CF_MAIL_API_KEY = cfg.cfApiKey || '';
  // Harvest browser proxy: pinned explicit proxy so registration does not
  // depend on the OS system-proxy state. Empty means "no panel override", so
  // auto-session falls back to HTTPS_PROXY/HTTP_PROXY (browserLaunchOptions).
  if (cfg.browserProxy !== undefined) process.env.SAKANA_BROWSER_PROXY = cfg.browserProxy || '';
}

function loadMailConfig() {
  applyMailConfig(readMailConfig());
}

function saveMailConfig(cfg) {
  // Shared resolver writes through runtime symlinks and survives dangling
  // links (realpathSync throws ENOENT there and would defeat the guard).
  const { atomicWriteState } = require('./state-file');
  atomicWriteState(MAIL_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  applyMailConfig(cfg);
  return true;
}

module.exports = { MAIL_CONFIG_FILE, readMailConfig, loadMailConfig, saveMailConfig, applyMailConfig };
