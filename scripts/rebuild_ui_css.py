#!/usr/bin/env python3
"""Replace the entire <style> block of public/index.html with the nirnor-inspired
design system. Markup/IDs/JS hooks are untouched — pure CSS rebuild."""

NEW_CSS = r"""
/* ============================================================
   Sakana 2API — nirnor-inspired editorial design system
   paper white / sumi ink · serif display · hairlines · grain
   ============================================================ */
:root {
  --bg: #f5f4f1;
  --bg-2: #fbfaf8;
  --bg-3: #efede9;
  --ink: #1a1a1a;
  --ink-2: #3c3c3c;
  --text: #1a1a1a;
  --text-muted: #7e7e7e;
  --text-dim: #a3a09a;
  --line: rgba(26, 26, 26, .14);
  --line-strong: rgba(26, 26, 26, .34);
  --accent: #cc4100;
  --accent-ink: #cc4100;
  --ok: #2f7d4f;
  --warn: #9a7500;
  --err: #b3261e;
  --card: var(--bg-2);
  --input-bg: #ffffff;
  --shadow: none;
  --serif: Georgia, 'Iowan Old Style', 'Times New Roman', 'Songti SC', 'Noto Serif CJK SC', 'SimSun', serif;
  --sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans', 'Microsoft YaHei', sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  --r: 2px;
  --sidebar-w: 232px;
}
html[data-theme="dark"] {
  --bg: #0d0d0c;
  --bg-2: #141412;
  --bg-3: #1b1b19;
  --ink: #eaeaea;
  --ink-2: #c9c7c2;
  --text: #eaeaea;
  --text-muted: #8f8d88;
  --text-dim: #5f5e5a;
  --line: rgba(234, 234, 234, .13);
  --line-strong: rgba(234, 234, 234, .32);
  --accent: #e05a1a;
  --ok: #6fbf8f;
  --warn: #d9b44a;
  --err: #e0645c;
  --card: var(--bg-2);
  --input-bg: #111110;
}
/* legacy hook: body.theme-light mirrors the light tokens */
body.theme-light {
  --bg: #f5f4f1; --bg-2: #fbfaf8; --bg-3: #efede9;
  --ink: #1a1a1a; --ink-2: #3c3c3c; --text: #1a1a1a;
  --text-muted: #7e7e7e; --text-dim: #a3a09a;
  --line: rgba(26,26,26,.14); --line-strong: rgba(26,26,26,.34);
  --accent: #cc4100; --ok: #2f7d4f; --warn: #9a7500; --err: #b3261e;
  --card: var(--bg-2); --input-bg: #ffffff;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}
/* paper grain — nirnor's signature texture */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
  opacity: .05;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E");
}
html[data-theme="dark"] body::before { opacity: .07; }

::selection { background: var(--ink); color: var(--bg); }
::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-thumb { background: var(--line-strong); border: 2px solid var(--bg); }
::-webkit-scrollbar-track { background: transparent; }

a { color: var(--text); text-decoration: none; }
h1, h2, h3 { font-weight: 500; }
code, pre, .mono, .json-viewer, .tree-method, .metric-val { font-family: var(--mono); }

/* ---------------- layout ---------------- */
.sidebar {
  position: fixed; left: 0; top: 0; bottom: 0; width: var(--sidebar-w);
  display: flex; flex-direction: column;
  background: var(--bg);
  border-right: 1px solid var(--line);
  z-index: 60;
  transition: transform .28s cubic-bezier(.4, 0, .2, 1), width .2s;
}
.main {
  margin-left: var(--sidebar-w);
  min-height: 100vh;
  display: flex; flex-direction: column;
  transition: margin-left .2s;
}
body.sidebar-collapsed .sidebar { transform: translateX(-100%); }
body.sidebar-collapsed .main { margin-left: 0; }

/* brand — serif wordmark, nirnor style */
.brand-area {
  display: flex; align-items: center; justify-content: space-between;
  padding: 26px 20px 22px;
  border-bottom: 1px solid var(--line);
}
.brand-left { display: flex; align-items: baseline; gap: 2px; cursor: pointer; }
.brand-logo { display: none; }
.brand-name {
  font-family: var(--serif);
  font-size: 24px; letter-spacing: .01em; color: var(--ink);
}
.brand-name span { color: var(--accent); }
.brand-ext { font-size: 15px; opacity: .55; transition: opacity .15s; }
.brand-ext:hover { opacity: 1; }

.sidebar-nav { flex: 1; overflow-y: auto; padding: 14px 0; }
.nav-btn, .tree-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 9px 20px; margin: 0;
  background: none; border: 0; cursor: pointer;
  color: var(--text-muted);
  font-family: var(--sans); font-size: 13px; letter-spacing: .04em;
  text-align: left; position: relative;
  transition: color .15s;
}
.nav-btn .nav-icon { display: none; }
.nav-btn:hover, .tree-item:hover { color: var(--ink); }
.nav-btn.active { color: var(--ink); }
.nav-btn.active::before {
  content: ''; position: absolute; left: 0; top: 8px; bottom: 8px;
  width: 2px; background: var(--accent);
}
.nav-badge {
  margin-left: auto; font-size: 9.5px; letter-spacing: .1em;
  color: var(--accent); border: 1px solid var(--accent);
  padding: 0 5px; border-radius: 999px; line-height: 15px;
}
.nav-section-title {
  padding: 18px 20px 6px;
  font-size: 10px; letter-spacing: .18em; text-transform: uppercase;
  color: var(--text-dim);
}
.tree-group { display: block; }
.tree-item { padding: 6px 20px 6px 30px; font-size: 12.5px; }
.tree-method {
  margin-left: auto; font-size: 9px; letter-spacing: .08em;
  color: var(--text-dim); border: 1px solid var(--line);
  padding: 0 4px; border-radius: 2px;
}
.sidebar-footer {
  border-top: 1px solid var(--line);
  padding: 12px 16px;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-dim); display: inline-block; }
.status-dot.ok { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent); animation: pulse 2.4s infinite; }
.status-dot.err { background: var(--err); }
@keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 24%, transparent); } 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 6%, transparent); } }

/* ---------------- topbar ---------------- */
.topbar {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
  padding: 30px 36px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
  position: sticky; top: 0; z-index: 40;
}
.topbar-title {
  display: flex; align-items: baseline; gap: 14px;
  font-family: var(--serif); font-size: 27px; color: var(--ink); line-height: 1.2;
}
.badge-tag {
  font-family: var(--mono); font-size: 10.5px; letter-spacing: .06em;
  color: var(--text-muted); border: 1px solid var(--line);
  padding: 1px 8px; border-radius: 999px; vertical-align: middle;
}
.topbar-subtitle { font-size: 12px; color: var(--text-dim); margin-top: 2px; letter-spacing: .02em; }
.mobile-menu-btn {
  display: none; background: none; border: 1px solid var(--line);
  color: var(--ink); font-size: 15px; padding: 5px 10px; cursor: pointer; border-radius: var(--r);
}

/* ---------------- buttons ---------------- */
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  background: transparent; color: var(--ink);
  border: 1px solid var(--line-strong);
  padding: 7px 16px; font-size: 12.5px; letter-spacing: .03em;
  font-family: var(--sans); cursor: pointer; border-radius: var(--r);
  transition: background .15s, color .15s, border-color .15s;
}
.btn:hover { border-color: var(--ink); background: var(--bg-2); }
.btn.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.btn.primary:hover { background: var(--ink-2); border-color: var(--ink-2); }
.btn.danger { color: var(--err); border-color: color-mix(in srgb, var(--err) 45%, transparent); }
.btn.danger:hover { background: color-mix(in srgb, var(--err) 8%, transparent); border-color: var(--err); }
.btn.sm { padding: 4px 11px; font-size: 11.5px; }
.btn.ghost { border-color: transparent; }
.btn.ghost:hover { border-color: var(--line-strong); }
.btn.active { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn-group { display: inline-flex; border: 1px solid var(--line-strong); border-radius: var(--r); overflow: hidden; }
.btn-group-btn {
  background: transparent; border: 0; color: var(--text-muted);
  padding: 6px 13px; font-size: 11.5px; letter-spacing: .06em; cursor: pointer;
  border-right: 1px solid var(--line); font-family: var(--mono);
}
.btn-group-btn:last-child { border-right: 0; }
.btn-group-btn.active { background: var(--ink); color: var(--bg); }

.pill {
  display: inline-block; font-size: 10px; letter-spacing: .12em; text-transform: uppercase;
  border: 1px solid var(--line-strong); color: var(--text-muted);
  padding: 1px 8px; border-radius: 999px; line-height: 16px; font-family: var(--mono);
}
.pill.on { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 55%, transparent); }
.pill.off { color: var(--text-dim); border-color: var(--line); }
.pill.info, .pill.blue, .pill.c-amber, .pill.c-blue, .pill.c-cyan, .pill.c-emerald { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); }

.input-text, .chat-textarea, select.chat-select, .input-text {
  background: var(--input-bg); color: var(--text);
  border: 1px solid var(--line-strong); border-radius: var(--r);
  padding: 8px 12px; font-size: 13px; font-family: var(--sans);
  outline: none; transition: border-color .15s;
}
.input-text:focus, .chat-textarea:focus, select.chat-select:focus { border-color: var(--ink); }
textarea.chat-textarea { width: 100%; resize: vertical; line-height: 1.7; }

/* ---------------- content & cards ---------------- */
.content-viewport { padding: 30px 36px 60px; flex: 1; }
.section-title {
  font-family: var(--serif); font-size: 21px; color: var(--ink);
  margin: 34px 0 14px; display: flex; align-items: baseline; gap: 10px;
}
.p-title { font-family: var(--serif); font-size: 19px; color: var(--ink); margin: 0; }
.card-panel {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 20px 22px;
}
.metric-card, .chart-card, .heatmap-card {
  background: var(--card); border: 1px solid var(--line); border-radius: var(--r);
  padding: 18px 20px;
}
.metric-card { display: flex; flex-direction: column; gap: 2px; }
.metric-head { display: flex; align-items: center; justify-content: space-between; }
.metric-icon { display: none; }
.metric-label { font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-dim); }
.metric-val { font-family: var(--serif); font-size: 34px; color: var(--ink); line-height: 1.15; }
.metric-sub { font-size: 11.5px; color: var(--text-dim); }
.dash-grid-top {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1px; background: var(--line); border: 1px solid var(--line);
}
.dash-grid-top > * { background: var(--card); border: 0; border-radius: 0; }
.ops-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
.ops-item { background: var(--card); padding: 12px 16px; }
.ops-label { font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-dim); }
.ops-val { font-family: var(--serif); font-size: 19px; color: var(--ink); }

.metric-bar { height: 2px; background: var(--line); position: relative; overflow: hidden; }
.metric-bar-fill { position: absolute; inset: 0 auto 0 0; background: var(--ink); }

/* tables */
.table-wrap { overflow-x: auto; border: 1px solid var(--line); background: var(--card); }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th {
  text-align: left; font-weight: 500; font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
  color: var(--text-dim); padding: 10px 14px; border-bottom: 1px solid var(--line-strong);
  white-space: nowrap;
}
td { padding: 9px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
tr:hover td { background: color-mix(in srgb, var(--ink) 3%, transparent); }

/* ---------------- model matrix ---------------- */
.model-matrix-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
.model-card {
  background: var(--card); border: 1px solid var(--line); border-radius: var(--r);
  padding: 18px 20px; transition: border-color .18s, transform .18s;
}
.model-card:hover { border-color: var(--ink); transform: translateY(-2px); }
.model-card-id { font-family: var(--mono); font-size: 13.5px; color: var(--ink); }
.model-card-desc { font-size: 12px; color: var(--text-muted); line-height: 1.55; margin-top: 6px; }
.model-card-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }

/* ---------------- chat ---------------- */
.chat-layout { display: flex; gap: 0; height: calc(100vh - 130px); border: 1px solid var(--line); background: var(--card); }
.chat-sidebar {
  width: 250px; border-right: 1px solid var(--line); display: flex; flex-direction: column;
  background: var(--bg);
}
.chat-top-header { padding: 14px 16px; border-bottom: 1px solid var(--line); font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-dim); display: flex; justify-content: space-between; align-items: center; }
.chat-history-list { flex: 1; overflow-y: auto; }
.chat-history-item { padding: 10px 16px; border-bottom: 1px solid var(--line); cursor: pointer; display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--text-muted); }
.chat-history-item.active { color: var(--ink); background: var(--bg-3); box-shadow: inset 2px 0 0 var(--accent); }
.chat-history-item .del-btn { opacity: 0; border: 0; background: none; color: var(--text-dim); cursor: pointer; }
.chat-history-item:hover .del-btn { opacity: 1; }
.chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.chat-viewport { flex: 1; overflow-y: auto; padding: 26px 34px; }
.chat-hero { text-align: left; padding: 40px 0 24px; }
.chat-hero-title { font-family: var(--serif); font-size: 30px; color: var(--ink); }
.chat-hero-desc { color: var(--text-muted); font-size: 13px; margin-top: 6px; }
.chat-suggestions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.suggestion-chip {
  border: 1px solid var(--line-strong); background: transparent; color: var(--text-muted);
  font-size: 12px; padding: 5px 13px; border-radius: 999px; cursor: pointer;
}
.suggestion-chip:hover { color: var(--ink); border-color: var(--ink); }
.msg-row { display: flex; gap: 12px; margin: 18px 0; }
.msg-avatar { display: none; }
.msg-bubble { max-width: 76%; padding: 12px 16px; font-size: 13.5px; line-height: 1.75; }
.msg-row.user { justify-content: flex-end; }
.msg-row.user .msg-bubble { background: var(--ink); color: var(--bg); border-radius: var(--r); }
.msg-row.assistant .msg-bubble { border: 1px solid var(--line); border-radius: var(--r); background: var(--bg-2); }
.msg-meta { font-size: 10px; color: var(--text-dim); margin-top: 6px; letter-spacing: .06em; }
.thinking-box {
  border-left: 2px solid var(--line-strong); padding: 6px 12px; margin: 6px 0;
  font-size: 12px; color: var(--text-muted); white-space: pre-wrap;
}
.typing-cursor::after { content: '▍'; animation: blink 1s steps(1) infinite; color: var(--accent); }
@keyframes blink { 50% { opacity: 0; } }
.chat-bottom-bar { border-top: 1px solid var(--line); padding: 14px 20px; background: var(--bg); }
.chat-controls-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.chat-controls-left { display: flex; gap: 8px; align-items: center; flex: 1; }
.attach-chip { display: inline-flex; gap: 6px; align-items: center; border: 1px solid var(--line); padding: 3px 10px; font-size: 11px; color: var(--text-muted); border-radius: 999px; }
.attachments-preview { display: flex; flex-wrap: wrap; gap: 8px; }
.citation-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.citation-tag { font-size: 10.5px; border: 1px solid var(--line); color: var(--text-muted); padding: 1px 8px; border-radius: 999px; }
.chat-drawer-backdrop, .sidebar-backdrop { display: none; }
body.drawer-open .sidebar { transform: translateX(0); }
body.drawer-open .sidebar-backdrop {
  display: block; position: fixed; inset: 0; background: rgba(10,10,10,.5); z-index: 55;
}
body.chat-drawer-open .chat-sidebar {
  transform: translateX(0); position: fixed; z-index: 70; top: 0; bottom: 0; left: 0;
}
body.chat-drawer-open .chat-drawer-backdrop {
  display: block; position: fixed; inset: 0; background: rgba(10,10,10,.5); z-index: 65;
}

/* ---------------- docs / code ---------------- */
.code-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 14px; border-bottom: 1px solid var(--line);
  font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-dim);
}
pre, .json-viewer {
  background: var(--bg-3); border: 1px solid var(--line);
  padding: 14px 16px; overflow-x: auto; font-size: 12px; line-height: 1.7;
  color: var(--ink-2);
}
.copy-btn { background: none; border: 1px solid var(--line); color: var(--text-muted); font-size: 10px; padding: 2px 9px; cursor: pointer; border-radius: 2px; letter-spacing: .1em; }
.copy-btn:hover { color: var(--ink); border-color: var(--ink); }

/* ---------------- modal & toast ---------------- */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(12,12,12,.55);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}
.modal-box {
  background: var(--bg-2); border: 1px solid var(--line-strong);
  max-width: 520px; width: calc(100% - 40px); padding: 26px 28px;
  border-radius: var(--r);
}
.modal-title { font-family: var(--serif); font-size: 20px; color: var(--ink); }
.modal-desc { font-size: 12.5px; color: var(--text-muted); margin: 8px 0 16px; }
.toast {
  position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
  background: var(--ink); color: var(--bg);
  padding: 10px 22px; font-size: 12.5px; letter-spacing: .04em;
  z-index: 300; border-radius: var(--r); opacity: 0; transition: opacity .2s;
  max-width: 80vw;
}
.toast.show { opacity: 1; }
.admin-lock-overlay { position: fixed; inset: 0; background: rgba(12,12,12,.6); display: flex; align-items: center; justify-content: center; z-index: 400; }
.admin-lock-card { background: var(--bg-2); border: 1px solid var(--line-strong); padding: 30px 32px; max-width: 460px; width: calc(100% - 40px); }

/* heatmap / podium / grouped stats */
.heatmap-grid { display: grid; grid-auto-flow: column; grid-template-rows: repeat(4, 1fr); gap: 3px; }
.heatmap-grid > div { border-radius: 1px; min-height: 12px; }
.podium-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }
.podium-badge { font-family: var(--serif); font-size: 17px; color: var(--ink); }
.podium-name { font-family: var(--mono); font-size: 12px; color: var(--text-muted); }
.grouped-stats-banner { border: 1px solid var(--line); background: var(--card); padding: 16px 20px; }
.group-stat-row { display: flex; gap: 22px; flex-wrap: wrap; }
.group-stat-item { min-width: 90px; }
.group-stat-num { font-family: var(--serif); font-size: 22px; color: var(--ink); }
.group-stat-title { font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-dim); }

.toggle-btn { background: none; border: 1px solid var(--line-strong); color: var(--text-muted); padding: 4px 12px; cursor: pointer; font-size: 11.5px; border-radius: var(--r); }
.toggle-btn.active { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.active-card-bar { border: 1px solid var(--line-strong); background: var(--bg-3); padding: 8px 14px; display: flex; gap: 10px; align-items: center; font-size: 12px; }
.preset-card { border: 1px solid var(--line); background: var(--card); padding: 14px 16px; cursor: pointer; transition: border-color .15s; }
.preset-card:hover { border-color: var(--ink); }
.badge-tag.danger, .text-danger { color: var(--err); }

/* ---------------- responsive ---------------- */
@media (max-width: 900px) {
  .sidebar { transform: translateX(-100%); }
  body.drawer-open .sidebar { transform: translateX(0); }
  .main { margin-left: 0; }
  .mobile-menu-btn { display: inline-block; }
  .topbar { padding: 18px 18px 14px; flex-wrap: wrap; }
  .topbar-title { font-size: 22px; }
  .content-viewport { padding: 20px 16px 50px; }
  .chat-layout { height: calc(100vh - 170px); }
  .chat-sidebar { position: fixed; transform: translateX(-100%); transition: transform .25s; z-index: 70; top: 0; bottom: 0; }
  .msg-bubble { max-width: 88%; }
  .chat-viewport { padding: 18px 16px; }
}
"""

path = 'public/index.html'
s = open(path, encoding='utf-8').read()
start = s.index('<style>')
end = s.index('</style>') + len('</style>')
s = s[:start] + '<style>' + NEW_CSS + '\n</style>' + s[end:]
open(path, 'w', encoding='utf-8').write(s)
print('style block replaced:', len(NEW_CSS), 'chars')
