#!/usr/bin/env python3
"""Replace the <style> block of public/index.html with a ChatGPT-style design
system (user request: clone OpenAI's UI, no custom flourishes). All element
IDs, classes and JS state hooks are preserved."""

NEW_CSS = r"""
/* ============================================================
   Sakana 2API — ChatGPT-style design system
   sidebar + centered content · rounded cards · pill buttons
   light (#fff / #f9f9f9) · dark (#212121 / #171717)
   ============================================================ */
:root {
  --bg: #ffffff;
  --bg-2: #f9f9f9;
  --bg-3: #f1f1f1;
  --ink: #0d0d0d;
  --ink-2: #353740;
  --text: #0d0d0d;
  --text-muted: #6e6e80;
  --text-dim: #a2a2ab;
  --line: rgba(13, 13, 13, .10);
  --line-strong: rgba(13, 13, 13, .22);
  --accent: #10a37f;
  --accent-hover: #0d8a6c;
  --ok: #10a37f;
  --warn: #f2a711;
  --err: #ef4146;
  --card: #ffffff;
  --input-bg: #ffffff;
  --sidebar-bg: #f9f9f9;
  --hover: #ececf1;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, .05);
  --shadow-md: 0 4px 16px rgba(0, 0, 0, .08);
  --shadow-lg: 0 12px 40px rgba(0, 0, 0, .12);
  --serif: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans', 'Microsoft YaHei', sans-serif;
  --sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans', 'Microsoft YaHei', sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  --r: 12px;
  --r-sm: 8px;
  --sidebar-w: 260px;
}
html[data-theme="dark"] {
  --bg: #212121;
  --bg-2: #171717;
  --bg-3: #2f2f2f;
  --ink: #ececec;
  --ink-2: #cfcfd4;
  --text: #ececec;
  --text-muted: #a0a0ab;
  --text-dim: #6f6f79;
  --line: rgba(255, 255, 255, .09);
  --line-strong: rgba(255, 255, 255, .2);
  --accent: #19c59d;
  --accent-hover: #10a37f;
  --ok: #19c59d;
  --warn: #f2a711;
  --err: #ef4146;
  --card: #2f2f2f;
  --input-bg: #2f2f2f;
  --sidebar-bg: #171717;
  --hover: #2f2f2f;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, .3);
  --shadow-md: 0 4px 16px rgba(0, 0, 0, .35);
  --shadow-lg: 0 12px 40px rgba(0, 0, 0, .5);
}
/* legacy hook: body.theme-light mirrors the light tokens */
body.theme-light {
  --bg: #ffffff; --bg-2: #f9f9f9; --bg-3: #f1f1f1;
  --ink: #0d0d0d; --ink-2: #353740; --text: #0d0d0d;
  --text-muted: #6e6e80; --text-dim: #a2a2ab;
  --line: rgba(13,13,13,.10); --line-strong: rgba(13,13,13,.22);
  --accent: #10a37f; --ok: #10a37f; --warn: #f2a711; --err: #ef4146;
  --card: #ffffff; --input-bg: #ffffff; --sidebar-bg: #f9f9f9; --hover: #ececf1;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.05); --shadow-md: 0 4px 16px rgba(0,0,0,.08); --shadow-lg: 0 12px 40px rgba(0,0,0,.12);
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

::selection { background: color-mix(in srgb, var(--accent) 22%, transparent); }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 99px; }
::-webkit-scrollbar-track { background: transparent; }

a { color: var(--text); text-decoration: none; }
h1, h2, h3 { font-weight: 600; }
code, pre, .mono, .json-viewer, .tree-method { font-family: var(--mono); }

/* ---------------- layout ---------------- */
.sidebar {
  position: fixed; left: 0; top: 0; bottom: 0; width: var(--sidebar-w);
  display: flex; flex-direction: column;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--line);
  z-index: 60;
  transition: transform .25s ease;
}
.main {
  margin-left: var(--sidebar-w);
  min-height: 100vh;
  display: flex; flex-direction: column;
  transition: margin-left .2s;
}
body.sidebar-collapsed .sidebar { transform: translateX(-100%); }
body.sidebar-collapsed .main { margin-left: 0; }

/* brand */
.brand-area {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 14px 10px;
}
.brand-left { display: flex; align-items: center; gap: 9px; cursor: pointer; padding: 4px 6px; border-radius: var(--r-sm); }
.brand-left:hover { background: var(--hover); }
.brand-logo {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--ink); color: var(--bg);
  display: flex; align-items: center; justify-content: center; font-size: 15px;
}
.brand-name { font-size: 15px; font-weight: 600; color: var(--ink); letter-spacing: .01em; }
.brand-name span { color: var(--text-muted); font-weight: 400; }
.brand-ext { font-size: 15px; opacity: .5; transition: opacity .15s; padding: 4px; border-radius: 6px; }
.brand-ext:hover { opacity: 1; background: var(--hover); }

.sidebar-nav { flex: 1; overflow-y: auto; padding: 4px 8px 8px; }
.nav-btn, .tree-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 8px 10px; margin: 1px 0;
  background: none; border: 0; cursor: pointer;
  color: var(--text-muted);
  font-family: var(--sans); font-size: 13.5px; font-weight: 450;
  text-align: left; border-radius: 10px;
  transition: background .12s, color .12s;
}
.nav-btn:hover, .tree-item:hover { background: var(--hover); color: var(--ink); }
.nav-btn.active { background: var(--hover); color: var(--ink); font-weight: 600; }
.nav-btn .nav-icon { width: 18px; text-align: center; font-size: 14px; }
.nav-badge {
  margin-left: auto; font-size: 9.5px; font-weight: 600; letter-spacing: .04em;
  color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent);
  padding: 1px 7px; border-radius: 999px; line-height: 15px;
}
.nav-section-title {
  padding: 14px 10px 4px;
  font-size: 11px; font-weight: 600; color: var(--text-dim); letter-spacing: .02em;
}
.tree-item { padding: 6px 10px 6px 18px; font-size: 12.5px; }
.tree-method {
  margin-left: auto; font-size: 9.5px; font-weight: 600; letter-spacing: .05em;
  color: var(--text-dim); background: var(--bg-3);
  padding: 1px 6px; border-radius: 5px;
}
.sidebar-footer {
  border-top: 1px solid var(--line);
  padding: 10px 14px;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-dim); display: inline-block; }
.status-dot.ok { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 15%, transparent); }
.status-dot.err { background: var(--err); }

/* ---------------- topbar ---------------- */
.topbar {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px 24px;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
  position: sticky; top: 0; z-index: 66;
}
.topbar-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.topbar-title { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600; color: var(--ink); }
.badge-tag {
  font-family: var(--mono); font-size: 10.5px; letter-spacing: .04em;
  color: var(--text-muted); background: var(--bg-2);
  padding: 2px 9px; border-radius: 999px; border: 1px solid var(--line);
}
.topbar-subtitle { font-size: 12px; color: var(--text-dim); }
.mobile-menu-btn {
  display: none; background: none; border: 0;
  color: var(--ink); font-size: 17px; padding: 6px 8px; cursor: pointer; border-radius: 8px;
}
.mobile-menu-btn:hover { background: var(--hover); }

/* ---------------- buttons ---------------- */
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  background: transparent; color: var(--ink);
  border: 1px solid var(--line-strong);
  padding: 8px 15px; font-size: 13px; font-weight: 500;
  font-family: var(--sans); cursor: pointer; border-radius: 999px;
  transition: background .12s, border-color .12s, box-shadow .12s;
}
.btn:hover { background: var(--hover); }
.btn.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.btn.primary:hover { background: var(--ink-2); border-color: var(--ink-2); }
.btn.danger { color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, transparent); }
.btn.danger:hover { background: color-mix(in srgb, var(--err) 8%, transparent); }
.btn.sm { padding: 5px 12px; font-size: 12px; }
.btn.ghost { border-color: transparent; }
.btn.ghost:hover { background: var(--hover); }
.btn.active { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn-group { display: inline-flex; background: var(--bg-2); border: 1px solid var(--line); border-radius: 999px; padding: 2px; }
.btn-group-btn {
  background: transparent; border: 0; color: var(--text-muted);
  padding: 5px 13px; font-size: 12px; font-weight: 500; cursor: pointer;
  border-radius: 999px; font-family: var(--sans);
}
.btn-group-btn.active { background: var(--card); color: var(--ink); box-shadow: var(--shadow-sm); }

.pill {
  display: inline-block; font-size: 10.5px; font-weight: 600; letter-spacing: .03em;
  border: 1px solid var(--line); color: var(--text-muted);
  padding: 2px 9px; border-radius: 999px; line-height: 16px;
}
.pill.on { color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent); border-color: transparent; }
.pill.off { color: var(--text-dim); }
.pill.info, .pill.blue, .pill.c-amber, .pill.c-blue, .pill.c-cyan, .pill.c-emerald { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); border-color: transparent; }

.input-text, .chat-textarea, select.chat-select {
  background: var(--input-bg); color: var(--text);
  border: 1px solid var(--line); border-radius: 10px;
  padding: 8px 13px; font-size: 13px; font-family: var(--sans);
  outline: none; transition: border-color .12s, box-shadow .12s;
}
.input-text:focus, .chat-textarea:focus, select.chat-select:focus {
  border-color: var(--line-strong);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
}
textarea.chat-textarea { width: 100%; resize: none; line-height: 1.7; }

/* ---------------- content & cards ---------------- */
.content-viewport { padding: 24px 28px 60px; flex: 1; max-width: 1180px; width: 100%; margin: 0 auto; }
.section-title {
  font-size: 19px; font-weight: 600; color: var(--ink);
  margin: 26px 0 14px; display: flex; align-items: baseline; gap: 10px;
}
.p-title { font-size: 16px; font-weight: 600; color: var(--ink); margin: 0; }
.card-panel {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 18px 20px;
  box-shadow: var(--shadow-sm);
}
.metric-card, .chart-card, .heatmap-card {
  background: var(--card); border: 1px solid var(--line); border-radius: 16px;
  padding: 16px 18px; box-shadow: var(--shadow-sm);
}
.metric-card { display: flex; flex-direction: column; gap: 3px; }
.metric-head { display: flex; align-items: center; justify-content: space-between; }
.metric-icon { font-size: 14px; opacity: .7; }
.metric-label { font-size: 11px; font-weight: 500; color: var(--text-dim); letter-spacing: .02em; }
.metric-val { font-size: 27px; font-weight: 600; color: var(--ink); line-height: 1.2; }
.metric-sub { font-size: 11.5px; color: var(--text-dim); }
.dash-grid-top {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px;
}
.ops-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 12px; }
.ops-item { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 12px 16px; }
.ops-label { font-size: 11px; color: var(--text-dim); font-weight: 500; }
.ops-val { font-size: 18px; font-weight: 600; color: var(--ink); }

.metric-bar { height: 4px; background: var(--bg-3); border-radius: 99px; position: relative; overflow: hidden; margin-top: 8px; }
.metric-bar-fill { position: absolute; inset: 0 auto 0 0; background: var(--accent); border-radius: 99px; }

/* tables */
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 14px; background: var(--card); box-shadow: var(--shadow-sm); }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th {
  text-align: left; font-weight: 600; font-size: 11px; color: var(--text-dim);
  padding: 10px 14px; border-bottom: 1px solid var(--line);
  white-space: nowrap; background: var(--bg-2);
}
td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
tr:hover td { background: var(--hover); }

/* ---------------- model matrix ---------------- */
.model-matrix-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
.model-card {
  background: var(--card); border: 1px solid var(--line); border-radius: 16px;
  padding: 18px 20px; transition: box-shadow .15s, border-color .15s;
  display: flex; flex-direction: column; justify-content: space-between;
}
.model-card:hover { box-shadow: var(--shadow-md); border-color: var(--line-strong); }
.model-card-id { font-family: var(--mono); font-size: 13.5px; font-weight: 600; color: var(--ink); }
.model-card-desc { font-size: 12.5px; color: var(--text-muted); line-height: 1.55; margin-top: 6px; }
.model-card-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.model-card .btn { border-radius: 999px; }

/* ---------------- chat ---------------- */
.chat-layout { display: flex; gap: 0; height: calc(100vh - 130px); border-radius: 18px; overflow: hidden; border: 1px solid var(--line); background: var(--card); box-shadow: var(--shadow-sm); }
.chat-sidebar {
  width: 258px; display: flex; flex-direction: column;
  background: var(--sidebar-bg); border-right: 1px solid var(--line);
}
.chat-top-header { padding: 10px 12px; display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.chat-history-list { flex: 1; overflow-y: auto; padding: 4px 8px; }
.chat-history-item { padding: 8px 10px; border-radius: 10px; cursor: pointer; display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--text-muted); margin: 1px 0; }
.chat-history-item.active { color: var(--ink); background: var(--hover); font-weight: 500; }
.chat-history-item:hover { background: var(--hover); }
.chat-history-item .del-btn { opacity: 0; border: 0; background: none; color: var(--text-dim); cursor: pointer; border-radius: 6px; padding: 1px 5px; }
.chat-history-item:hover .del-btn { opacity: 1; }
.chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg); }
.chat-viewport { flex: 1; overflow-y: auto; padding: 24px 24px 10px; }
.chat-viewport > * { max-width: 820px; margin-left: auto; margin-right: auto; }
.chat-hero { text-align: center; padding: 64px 0 28px; }
.chat-hero-title { font-size: 26px; font-weight: 600; color: var(--ink); }
.chat-hero-desc { color: var(--text-muted); font-size: 13px; margin-top: 8px; }
.chat-suggestions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; justify-content: center; }
.suggestion-chip {
  border: 1px solid var(--line); background: var(--card); color: var(--text-muted);
  font-size: 12.5px; padding: 7px 14px; border-radius: 999px; cursor: pointer;
  box-shadow: var(--shadow-sm); transition: border-color .12s, color .12s;
}
.suggestion-chip:hover { color: var(--ink); border-color: var(--line-strong); }
.msg-row { display: flex; gap: 12px; margin: 18px 0; }
.msg-avatar {
  width: 28px; height: 28px; border-radius: 50%; flex: none;
  background: var(--bg-3); display: flex; align-items: center; justify-content: center; font-size: 13px;
  border: 1px solid var(--line);
}
.msg-bubble { max-width: 76%; padding: 12px 16px; font-size: 14px; line-height: 1.75; }
.msg-row.user { justify-content: flex-end; }
.msg-row.user .msg-bubble { background: var(--bg-2); color: var(--text); border-radius: 24px; padding: 10px 18px; }
.msg-row.assistant .msg-bubble { background: transparent; padding: 4px 2px; }
.msg-meta { font-size: 10.5px; color: var(--text-dim); margin-top: 6px; }
.thinking-box {
  background: var(--bg-2); border-radius: 10px; padding: 8px 12px; margin: 6px 0;
  font-size: 12px; color: var(--text-muted); white-space: pre-wrap;
}
.typing-cursor::after { content: '▍'; animation: blink 1s steps(1) infinite; color: var(--accent); }
@keyframes blink { 50% { opacity: 0; } }
.chat-bottom-bar { padding: 12px 20px 14px; background: var(--bg); }
.chat-bottom-bar > * { max-width: 820px; margin-left: auto; margin-right: auto; }
.chat-input-card, .chat-textarea {
  border: 1px solid var(--line-strong); border-radius: 24px; background: var(--input-bg);
  box-shadow: var(--shadow-md);
}
.chat-controls-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.chat-controls-left { display: flex; gap: 8px; align-items: center; flex: 1; }
.chat-controls-row .btn, .chat-controls-row .btn.primary {
  border-radius: 999px;
}
.attach-chip { display: inline-flex; gap: 6px; align-items: center; background: var(--bg-2); border: 1px solid var(--line); padding: 3px 10px; font-size: 11px; color: var(--text-muted); border-radius: 999px; }
.attachments-preview { display: flex; flex-wrap: wrap; gap: 8px; }
.citation-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.citation-tag { font-size: 10.5px; background: var(--bg-2); color: var(--text-muted); padding: 2px 9px; border-radius: 999px; border: 1px solid var(--line); }
.chat-drawer-backdrop, .sidebar-backdrop { display: none; }
.sidebar.drawer-open { transform: translateX(0); }
.sidebar-backdrop:not([hidden]) {
  display: block; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 55;
}
.chat-sidebar.chat-drawer-open {
  transform: translateX(0); position: fixed; z-index: 70; top: 0; bottom: 0; left: 0;
  border-radius: 0;
}
.chat-drawer-backdrop:not([hidden]) {
  display: block; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 65;
}

/* ---------------- docs / code ---------------- */
.code-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 14px;
  font-size: 11px; font-weight: 600; color: var(--text-dim);
  background: var(--bg-2); border-radius: 10px 10px 0 0; border: 1px solid var(--line); border-bottom: 0;
}
pre, .json-viewer {
  background: var(--bg-2); border: 1px solid var(--line); border-radius: 0 0 10px 10px;
  padding: 14px 16px; overflow-x: auto; font-size: 12.5px; line-height: 1.7;
  color: var(--ink-2);
}
pre:not(.json-viewer) { border-radius: 10px; }
.copy-btn { background: var(--card); border: 1px solid var(--line); color: var(--text-muted); font-size: 10.5px; font-weight: 500; padding: 3px 10px; cursor: pointer; border-radius: 7px; }
.copy-btn:hover { color: var(--ink); border-color: var(--line-strong); }

/* ---------------- modal & toast ---------------- */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.4);
  backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}
.modal-box {
  background: var(--card); border: 1px solid var(--line);
  max-width: 520px; width: calc(100% - 40px); padding: 24px 26px;
  border-radius: 20px; box-shadow: var(--shadow-lg);
}
.modal-title { font-size: 17px; font-weight: 600; color: var(--ink); }
.modal-desc { font-size: 13px; color: var(--text-muted); margin: 8px 0 16px; }
.toast {
  position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
  background: var(--ink); color: var(--bg);
  padding: 10px 20px; font-size: 13px; font-weight: 500;
  z-index: 300; border-radius: 999px; opacity: 0; transition: opacity .2s;
  max-width: 80vw; box-shadow: var(--shadow-lg);
}
.toast.show { opacity: 1; }
.admin-lock-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; z-index: 400; }
.admin-lock-card { background: var(--card); border: 1px solid var(--line); padding: 28px 30px; max-width: 440px; width: calc(100% - 40px); border-radius: 20px; box-shadow: var(--shadow-lg); }

/* heatmap / podium / grouped stats */
.grouped-stats-banner { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.group-stat-item { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px; box-shadow: var(--shadow-sm); }
.group-stat-title { font-size: 11px; color: var(--text-dim); font-weight: 500; }
.group-stat-row { display: flex; align-items: baseline; gap: 6px; margin-top: 2px; }
.group-stat-num { font-size: 22px; font-weight: 600; color: var(--ink); }
.group-stat-sub { font-size: 11.5px; color: var(--text-dim); }
.heatmap-grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 4px; }
.heatmap-grid > div { border-radius: 4px; aspect-ratio: 2 / 1; min-height: 14px; }
.podium-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.podium-badge { font-size: 16px; font-weight: 600; color: var(--ink); }
.podium-name { font-family: var(--mono); font-size: 12px; color: var(--text-muted); }

.toggle-btn { background: var(--bg-2); border: 1px solid var(--line); color: var(--text-muted); padding: 5px 12px; cursor: pointer; font-size: 12px; font-weight: 500; border-radius: 999px; }
.toggle-btn.active { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.active-card-bar { background: var(--bg-2); border: 1px solid var(--line); padding: 8px 14px; display: flex; gap: 10px; align-items: center; font-size: 12px; border-radius: 12px; }
.preset-card { border: 1px solid var(--line); background: var(--card); padding: 14px 16px; cursor: pointer; transition: box-shadow .12s, border-color .12s; border-radius: 14px; }
.preset-card:hover { border-color: var(--line-strong); box-shadow: var(--shadow-sm); }
.badge-tag.danger, .text-danger { color: var(--err); }
.chart-canvas-container { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 14px; }
.chart-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.chart-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11.5px; color: var(--text-muted); }
.chart-legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 5px; }
.chart-metrics-row { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 10px; font-size: 12px; color: var(--text-muted); }
.chart-metric-pill { background: var(--bg-2); border-radius: 999px; padding: 4px 12px; }

/* ---------------- responsive ---------------- */
@media (max-width: 900px) {
  #btnOpenChatDrawer { display: inline-flex !important; }
  .sidebar { transform: translateX(-100%); }
  .main { margin-left: 0; }
  .mobile-menu-btn { display: inline-block; }
  .topbar { padding: 10px 14px; flex-wrap: wrap; }
  .topbar-title { font-size: 15px; }
  .topbar-subtitle { display: none; }
  .content-viewport { padding: 16px 12px 50px; }
  .chat-layout { height: calc(100vh - 150px); }
  .chat-sidebar { position: fixed; transform: translateX(-100%); transition: transform .25s; z-index: 70; top: 0; bottom: 0; }
  .msg-bubble { max-width: 88%; }
  .chat-viewport { padding: 16px 12px 8px; }
  .chat-viewport > * { max-width: 100%; }
  .chat-bottom-bar > * { max-width: 100%; }
}
"""

path = 'public/index.html'
s = open(path, encoding='utf-8').read()
start = s.index('<style>')
end = s.index('</style>') + len('</style>')
s = s[:start] + '<style>' + NEW_CSS + '\n</style>' + s[end:]
open(path, 'w', encoding='utf-8').write(s)
print('style block replaced:', len(NEW_CSS), 'chars')
