#!/usr/bin/env python3
"""Server-side hotfix: create runtime profile dir + patch live auto-session lib
with ensureProfileDir (dangling symlink defense). Idempotent."""
import re

P = '/root/sakana-2api/lib/auto-session.js'
s = open(P, encoding='utf-8').read()

if 'function ensureProfileDir' not in s:
    fix = (
        "function ensureProfileDir() {\n"
        "  try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch {}\n"
        "  try { fs.realpathSync(PROFILE_DIR); } catch { try { fs.rmSync(PROFILE_DIR); fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch {} }\n"
        "}\n\n"
    )
    s = s.replace('async function ensureBrowser(', fix + 'async function ensureBrowser(', 1)
    s = s.replace(
        'const launchPromise = (async () => {\n    const chromePath = getChromePath();',
        'const launchPromise = (async () => {\n    ensureProfileDir();\n    const chromePath = getChromePath();',
        1,
    )
    open(P, 'w', encoding='utf-8').write(s)
    print('patched live lib')
else:
    print('already patched')
