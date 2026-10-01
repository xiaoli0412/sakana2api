// Browser resource profiler: samples Node RSS/heap, Chromium child process
// CPU/memory/count, and the persistent profile's disk footprint while the
// production server runs. Summary statistics only — never dumps requests,
// prompts, cookies or tokens.
//
// Fail-closed: requires SAKANA_PROFILE_CONFIRM=1 because profiling needs the
// real browser stack (AUTO_SESSION) against the real upstream.
//
// Usage:
//   SAKANA_PROFILE_CONFIRM=1 node scripts/profile_browser.mjs [--pid 12345]
//       [--duration 300] [--interval 2000] [--out docs/profiles/xxx.json]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (process.env.SAKANA_PROFILE_CONFIRM !== '1') {
  console.error('profile_browser: refusing to run — set SAKANA_PROFILE_CONFIRM=1 (launches/samples the real browser stack)');
  process.exit(1);
}

function argNum(name, fallback) {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number.parseFloat(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function argStr(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
}

const durationMs = argNum('--duration', 300_000);
const intervalMs = argNum('--interval', 2000);
const outPath = argStr('--out');
const profileDir = path.join(root, '.browser-profile');

function findNodePid() {
  const wanted = path.join('server.js');
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name like 'node%' \\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"`,
        { encoding: 'utf8', timeout: 15000 },
      );
      const rows = JSON.parse(out || '[]');
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (String(row.CommandLine || '').includes(wanted)) return Number(row.ProcessId);
      }
    } else {
      const out = execSync('ps -eo pid,args', { encoding: 'utf8', timeout: 10000 });
      for (const line of out.split('\n')) {
        if (line.includes(wanted) && !line.includes('ps -eo')) return Number(line.trim().split(/\s+/)[0]);
      }
    }
  } catch {}
  return null;
}

function sampleWin32(pid) {
  const nodeStat = pid
    ? execSync(`powershell -NoProfile -Command "Get-Process -Id ${pid} | Select-Object Id,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json"`, { encoding: 'utf8', timeout: 10000 })
    : '{}';
  const chrome = execSync(
    `powershell -NoProfile -Command "Get-Process chrome,msedge -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,CPU | ConvertTo-Json"`,
    { encoding: 'utf8', timeout: 10000 },
  );
  return { nodeStat: JSON.parse(nodeStat || 'null'), chrome: JSON.parse(chrome || '[]') };
}

function sampleLinux(pid) {
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  const chrome = [];
  try {
    const procs = execSync('ps -eo pid,rss,pcpu,comm', { encoding: 'utf8', timeout: 10000 });
    for (const line of procs.split('\n')) {
      if (/chrome|chromium/.test(line)) {
        const [pidS, rssS, cpuS] = line.trim().split(/\s+/);
        chrome.push({ Id: Number(pidS), WorkingSet64: Number(rssS) * 1024, CPU: Number(cpuS) });
      }
    }
  } catch {}
  let nodeStat = null;
  if (pid) {
    const status = read(`/proc/${pid}/status`);
    const rss = /VmRSS:\s+(\d+)/.exec(status);
    if (rss) nodeStat = { Id: pid, WorkingSet64: Number(rss[1]) * 1024 };
  }
  return { nodeStat, chrome };
}

function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { total += fs.statSync(p).size; files++; } catch {}
      }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

function stats(arr) {
  if (!arr.length) return { n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0], avg: Math.round(avg), p95: pct(0.95), max: s[s.length - 1] };
}

const pid = Number(process.argv[process.argv.indexOf('--pid') + 1]) || findNodePid();
if (!pid) {
  console.error('profile_browser: no server PID found — start the server first or pass --pid');
  process.exit(1);
}
console.log(`profiling node pid=${pid} for ${Math.round(durationMs / 1000)}s (interval ${intervalMs}ms)…`);
const sample = process.platform === 'win32' ? sampleWin32 : sampleLinux;

const rss = [];
const heapUsed = [];
const heapTotal = [];
const chromeCount = [];
const chromeWs = [];
const diskSamples = [];
const t0 = Date.now();
let ticks = 0;

while (Date.now() - t0 < durationMs) {
  const mem = process.memoryUsage();
  let nodeWs = 0;
  let chrome = [];
  try {
    const s = sample(pid);
    nodeWs = s.nodeStat?.WorkingSet64 || 0;
    chrome = Array.isArray(s.chrome) ? s.chrome : (s.chrome ? [s.chrome] : []);
  } catch {}
  rss.push(nodeWs);
  heapUsed.push(mem.heapUsed);
  heapTotal.push(mem.heapTotal);
  chromeCount.push(chrome.length);
  chromeWs.push(chrome.reduce((a, c) => a + (c.WorkingSet64 || 0), 0));
  ticks++;
  if (ticks % 15 === 0) {
    const disk = dirSize(profileDir);
    diskSamples.push(disk);
    console.log(`t=${Math.round((Date.now() - t0) / 1000)}s nodeRSS=${(nodeWs / 1048576).toFixed(0)}MB heapUsed=${(mem.heapUsed / 1048576).toFixed(0)}MB chrome=${chrome.length} chromeWS=${(chromeWs[chromeWs.length - 1] / 1048576).toFixed(0)}MB profileDisk=${(disk.bytes / 1048576).toFixed(0)}MB/${disk.files}files`);
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}

const summary = {
  pid,
  durationSec: Math.round((Date.now() - t0) / 1000),
  ticks,
  nodeRssBytes: stats(rss.filter(Boolean)),
  heapUsedBytes: stats(heapUsed),
  heapTotalBytes: stats(heapTotal),
  chromeProcesses: stats(chromeCount),
  chromeWorkingSetBytes: stats(chromeWs),
  profileDir: diskSamples.length ? diskSamples[diskSamples.length - 1] : dirSize(profileDir),
  growth: {
    nodeRssPerHourBytes: rss.length > 1 && rss[rss.length - 1] > 0
      ? Math.round((rss[rss.length - 1] - rss.find((v) => v > 0)) / ((Date.now() - t0) / 3600000))
      : 0,
    chromeWsPerHourBytes: chromeWs.length > 1 && chromeWs[chromeWs.length - 1] > 0
      ? Math.round((chromeWs[chromeWs.length - 1] - chromeWs.find((v) => v > 0)) / ((Date.now() - t0) / 3600000))
      : 0,
  },
};
console.log('\n=== profile summary ===');
console.log(JSON.stringify(summary, (k, v) => (k.endsWith('Bytes') && typeof v === 'object' && v && !Array.isArray(v))
  ? Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, Number.isFinite(vv) ? Math.round(vv / 1048576 * 10) / 10 + 'MB' : vv]))
  : v, 2));
if (outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(summary, null, 2));
  console.log(`written: ${outPath}`);
}
