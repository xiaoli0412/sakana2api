'use strict';
// Text helpers shared by protocol translation and the NDJSON stream translator.
// Extracted from lib/translate.js (P2 split) without behavior changes.

const clean = (s) => String(s || '').replaceAll('\0', '');
const stripChips = (s) => String(s || '').replace(/<source-chip[^>]*\/>/g, '');

// Helper: Parse generative JSON / Tagged tool calls from model output.
// Strategy tiers:
//   1. Tagged format: <tool_call>...</tool_call> / <function_call>...</function_call>
//   2. Whole-output markdown JSON block (```json ... ``` or bare object/array)
//   3. Embedded scan: brace-balanced, string-literal-aware walk from every
//      '{' / '[' candidate that looks like a tool call (capped at 100), so
//      calls buried in prose or markdown ("结果如下:{"tool":"get_weather",...}")
//      are still surfaced to clients.
function extractJsonToolCalls(text) {
  if (!text || typeof text !== 'string') return null;
  const calls = [];

  const pushCall = (item) => {
    if (!item || typeof item !== 'object') return;
    const name = item.name || item.tool || (item.function && item.function.name);
    const args = item.arguments || item.parameters || (item.function && item.function.arguments) || {};
    if (name && typeof name === 'string' && name !== 'finalizing') {
      calls.push({
        name: String(name),
        arguments: typeof args === 'object' ? JSON.stringify(args) : String(args || '{}'),
      });
    }
  };

  // 1. Tagged format: <tool_call>...</tool_call> or <function_call>...</function_call>
  const tagRegex = /<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/gi;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(text)) !== null) {
    try { pushCall(JSON.parse(tagMatch[1].trim())); } catch {}
  }
  if (calls.length > 0) return calls;

  // 2. Markdown block: ```json ... ``` or bare JSON object/array spanning the output
  const blockMatch = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text) ||
                     /^\s*(\[[\s\S]*\]|\{[\s\S]*\})\s*$/i.exec(text);
  if (blockMatch) {
    try {
      const parsed = JSON.parse(blockMatch[1].trim());
      (Array.isArray(parsed) ? parsed : [parsed]).forEach(pushCall);
    } catch {}
  }
  if (calls.length > 0) return calls;

  // 3. Embedded scan: for each '{' / '[' candidate, do a balanced scan that
  //    understands string literals, and JSON.parse the captured slice.
  const scanFrom = (start) => {
    const open = text[start];
    const depth = { '{': 0, '[': 0 };
    let inStr = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{' || ch === '[') depth[ch]++;
      else if (ch === '}' || ch === ']') {
        const pair = ch === '}' ? '{' : '[';
        if (--depth[pair] < 0) return null;
        if (depth[pair] === 0 && pair === open) return text.slice(start, i + 1);
      }
    }
    return null;
  };

  let candidates = 0;
  for (let i = 0; i < text.length && candidates < 100; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    // Cheap pre-filter: a likely tool-call object mentions a key we map from.
    const snippet = text.slice(i, Math.min(i + 120, text.length));
    if (!/"(?:tool|name|function|action|args|arguments|parameters)"/.test(snippet)) continue;
    candidates++;
    const json = scanFrom(i);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json);
      (Array.isArray(parsed) ? parsed : [parsed]).forEach(pushCall);
    } catch {}
  }

  return calls.length > 0 ? calls : null;
}

module.exports = { clean, stripChips, extractJsonToolCalls };