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
}

function loadMailConfig() {
  applyMailConfig(readMailConfig());
}

function saveMailConfig(cfg) {
  let target = MAIL_CONFIG_FILE;
  try {
    if (fs.lstatSync(target).isSymbolicLink()) target = fs.realpathSync(target);
  } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
  applyMailConfig(cfg);
  return true;
}

module.exports = { MAIL_CONFIG_FILE, readMailConfig, loadMailConfig, saveMailConfig, applyMailConfig };
