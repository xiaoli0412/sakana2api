#!/bin/sh
set -eu

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8787}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"

if [ "${AUTO_SESSION:-true}" = "true" ]; then
  export DISPLAY="${DISPLAY:-:99}"
  exec xvfb-run --auto-servernum --server-args="-screen 0 1280x900x24" node server.js
fi

exec node server.js
