'use strict';
// Public model matrix data, extracted from lib/translate.js (P2 split).
// Behavior-neutral: translate.js re-exports MODELS / MODEL_PROFILES so every
// existing consumer keeps its import path.

// Upstream model names verified against the 2026-10 client registry
// (sakana-namazu + fugu-max; "fugu" alone no longer appears in the bundle).
// SAKANA_MINI_UPSTREAM / SAKANA_CODE_UPSTREAM allow a live override if upstream
// renames again (hot-fix pattern, no release needed).
const MINI_UPSTREAM = process.env.SAKANA_MINI_UPSTREAM || 'fugu-max';
// Measured 2026-10 against the real upstream (scripts/probe_models.mjs):
// fugu-max and sakana-namazu tie on reasoning/writing/translation; fugu-max
// produces the tighter, more surgical code fixes, so code profiles ride it.
const CODE_UPSTREAM = process.env.SAKANA_CODE_UPSTREAM || 'fugu-max';

// Public profiles select an upstream model and tone. Search/thinking are
// mutually exclusive upstream (INPUT-MODE-001); code/writer search→think
// chaining is available through an explicit request or environment opt-in.
const MODEL_PROFILES = [
  { id: 'sakana',             family: 'standard',  tier: 'full', upstream: 'sakana-namazu', tone: 'default',  label: 'Sakana',             desc: '标准对话 · 深度思考' },
  { id: 'sakana-mini',        family: 'standard',  tier: 'mini', upstream: MINI_UPSTREAM,   tone: 'default',  label: 'Sakana Mini',        desc: '轻量快速 · 深度思考' },
  { id: 'sakana-code',        family: 'code',      tier: 'full', upstream: CODE_UPSTREAM,    tone: 'default',  label: 'Sakana Code',        desc: '编程 · 代码准确 · 工具支持' },
  { id: 'sakana-code-mini',   family: 'code',      tier: 'mini', upstream: CODE_UPSTREAM,   tone: 'default',  label: 'Sakana Code Mini',   desc: '编程轻量 · 代码准确 · 工具支持' },
  { id: 'sakana-writer',      family: 'writer',    tier: 'full', upstream: 'sakana-namazu', tone: 'default',  label: 'Sakana Writer',      desc: '超长文本写作 · 上下文压缩管线' },
  { id: 'sakana-writer-mini', family: 'writer',    tier: 'mini', upstream: MINI_UPSTREAM,   tone: 'default',  label: 'Sakana Writer Mini', desc: '写作轻量 · 上下文压缩管线' },
  { id: 'sakana-translate',   family: 'translate', tier: 'full', upstream: 'sakana-namazu', tone: 'default',  label: 'Sakana Translate',   desc: '大批量翻译 · 格式保真 · 术语一致' },
  { id: 'sakana-polite',      family: 'standard',  tier: 'full', upstream: 'sakana-namazu', tone: 'jp-vibes', label: 'Sakana Polite',      desc: '敬语风格 · 深度思考' },
  { id: 'sakana-osaka',       family: 'standard',  tier: 'full', upstream: 'sakana-namazu', tone: 'osaka',    label: 'Sakana Osaka',       desc: 'Osaka 风格 · 深度思考' },
];

const MODEL_BY_ID = new Map(MODEL_PROFILES.map((p) => [p.id, p]));

const MODELS = MODEL_PROFILES.map((p) => ({
  id: p.id, object: 'model', created: 0, owned_by: 'sakana',
  description: `${p.label} · ${p.desc}`,
  apiModel: p.upstream, tone: p.tone, family: p.family, tier: p.tier, search: false,
}));

module.exports = { MODEL_PROFILES, MODEL_BY_ID, MODELS, MINI_UPSTREAM, CODE_UPSTREAM };