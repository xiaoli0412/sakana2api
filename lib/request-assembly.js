'use strict';

const { openaiRequestToSakana, normalizedMessagesToPrompt } = require('./translate');

function requestedHistoryMode(body = {}) {
  const mode = String(body.history_mode || body.historyMode || '').toLowerCase();
  if (mode) return mode;
  const explicitId = body.conversation_id || body.chat_id || body.thread_id;
  return explicitId ? 'delta' : 'full';
}

function selectContextSuffix(body = {}, stored = null) {
  // Full history is the compatible default: send only turns the upstream
  // conversation does not already own. Explicit delta requests already carry
  // only the new turn and must pass through unchanged.
  if (requestedHistoryMode(body) === 'delta' || !stored || !Array.isArray(body.messages)) return body;
  const count = Number(stored.messageCount);
  if (!Number.isInteger(count) || count <= 0 || body.messages.length <= count) return body;
  let messages = body.messages.slice(count);
  // The upstream conversation already contains prior assistant turns.
  while (messages[0]?.role === 'assistant') messages = messages.slice(1);
  return { ...body, messages };
}

function selectNormalizedSuffix(normalized = {}, body = {}, stored = null) {
  const effectiveBody = selectContextSuffix(body, stored);
  if (effectiveBody === body) return normalized;
  const count = Number(stored?.messageCount);
  if (!Number.isInteger(count) || count <= 0 || !Array.isArray(normalized.messages) || normalized.messages.length <= count) {
    return normalized;
  }
  const messages = normalized.messages.slice(count).filter((message, index) => {
    if (index !== 0 || message?.role !== 'assistant') return true;
    return false;
  });
  const attachmentIds = new Set();
  for (const message of messages) {
    for (const part of message?.parts || []) {
      if (part?.kind === 'attachment' && part.attachment?.id) attachmentIds.add(part.attachment.id);
    }
  }
  const attachments = (normalized.attachments || []).filter((attachment) => attachmentIds.has(attachment.id));
  return { ...normalized, messages, attachments };
}

/**
 * Build the single upstream request shape used by all OpenAI-compatible routes.
 * The normalized message graph is authoritative; the raw translator is kept
 * only for model flags, tool hints, and the long-document wrapper.
 */
function buildNormalizedSakanaRequest(body = {}, normalized = {}, stored = null) {
  const effectiveBody = selectContextSuffix(body, stored);
  const effectiveNormalized = selectNormalizedSuffix(normalized, body, stored);
  const sakanaReq = openaiRequestToSakana(effectiveBody);
  if (stored?.conversationId) sakanaReq.conversationId = stored.conversationId;
  const normalizedMessages = Array.isArray(effectiveNormalized.messages) ? effectiveNormalized.messages : [];
  const normalizedPrompt = normalizedMessagesToPrompt(normalizedMessages);
  const rawPrompt = sakanaReq.prompt || '';
  const translatorFiles = Array.isArray(sakanaReq.files) ? sakanaReq.files : [];
  const contextFile = translatorFiles.find((file) => file && file.synthetic && /^context_document\.(txt|json)$/.test(file.name));

  if (normalizedPrompt) {
    sakanaReq.prompt = contextFile ? rawPrompt : normalizedPrompt;
  }
  if (!contextFile && rawPrompt.includes('可用自定义工具列表')) {
    const hint = rawPrompt.slice(rawPrompt.indexOf('可用自定义工具列表'));
    sakanaReq.prompt = [sakanaReq.prompt, hint].filter(Boolean).join('\n\n');
  }

  const attachments = Array.isArray(effectiveNormalized.attachments) ? effectiveNormalized.attachments : [];
  sakanaReq.normalizedMessages = normalizedMessages;
  sakanaReq.attachments = attachments;
  sakanaReq.files = [
    ...attachments.map((attachment) => ({
      type: 'base64',
      name: attachment.name,
      mime: attachment.mime,
      buf: attachment.buf,
    })),
    ...translatorFiles.filter((file) => !attachments.some((attachment) =>
      attachment.name === file.name && attachment.buf?.equals?.(file.buf)
    )),
  ];

  // Keep the translator's synthetic document byte-for-byte intact. The
  // normalized prompt is the visible request text; rewriting the attachment
  // here would turn an explicit budget clip into a silently truncated file.

  return { sakanaReq, normalizedPrompt, normalized: effectiveNormalized, body: effectiveBody };
}

module.exports = {
  requestedHistoryMode,
  selectContextSuffix,
  selectNormalizedSuffix,
  buildNormalizedSakanaRequest,
};
