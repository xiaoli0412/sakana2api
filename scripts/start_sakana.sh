#!/bin/bash
# Start the sakana-2api server on a headless Linux box (with Xvfb).
# Defaults to localhost; set HOST=0.0.0.0 only together with API_KEY.
#
# Optional hardening: export API_KEY=your-admin-key before calling,
# or create keys from the panel after first start.
cd /root/sakana-2api
export DISPLAY=:99
# Runtime env (YYDS_API_KEY, SAKANA_MAIL_PROVIDER, YYDS_DOMAIN, …) lives in
# the state-only runtime dir and survives deploys; keep secrets out of git.
[[ -f ./runtime/env.sh ]] && source ./runtime/env.sh
export HOST="${HOST:-127.0.0.1}"
if [[ "$HOST" != "127.0.0.1" && "$HOST" != "localhost" && "$HOST" != "::1" && -z "${API_KEY:-}" ]]; then
  echo "API_KEY is required when HOST is publicly reachable" >&2
  exit 1
fi
# Defaults match lib/account-pool.js; override them in the environment.
export ACCOUNT_POOL_MIN="${ACCOUNT_POOL_MIN:-50}"
export ACCOUNT_POOL_MAX="${ACCOUNT_POOL_MAX:-50}"
export ACCOUNT_REFRESH_MS="${ACCOUNT_REFRESH_MS:-1200000}"
export ACCOUNT_REPLENISH_MS="${ACCOUNT_REPLENISH_MS:-90000}"
nohup node server.js > server.log 2>&1 &
echo started
