#!/bin/bash
# Start the sakana-2api server on a headless Linux box (with Xvfb).
# Binds 0.0.0.0 so the web panel + API are reachable from outside.
#
# Optional hardening: export API_KEY=your-admin-key before calling,
# or create keys from the panel after first start.
cd /root/sakana-2api
export DISPLAY=:99
export HOST=0.0.0.0
nohup node server.js > server.log 2>&1 &
echo started