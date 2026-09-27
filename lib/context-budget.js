'use strict';

// Deterministic measurements shared by request normalization and focused tests.

const DEFAULT_MAX_TEXT_BYTES = Infinity;
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_TEXT_BYTES = Infinity;
const DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES = Infinity;
const DEFAULT_MAX_MULTIPART_BYTES = Infinity;
const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_BOUNDARY_BYTES = Buffer.byteLength('----WebKitFormBoundary', 'utf8') + 16;

const BUDGET_ERROR_CODES = Object.freeze({
  TEXT_BUDGET_EXCEEDED: 'TEXT_BUDGET_EXCEEDED',
  ATTACHMENT_BUDGET_EXCEEDED: 'ATTACHMENT_BUDGET_EXCEEDED',
  MULTIPART_BUDGET_EXCEEDED: 'MULTIPART_BUDGET_EXCEEDED',
  CONTEXT_BUDGET_EXCEEDED: 'CONTEXT_BUDGET_EXCEEDED',
});

const CLIP_CODES = Object.freeze({
  TEXT_CLIPPED: 'TEXT_CLIPPED',
});

function asText(value) {
  return value == null ? '' : String(value);
}

function countChars(value) {
  // Array.from counts Unicode code points rather than UTF-16 code units.
  return Array.from(asText(value)).length;
}

function utf8ByteLength(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  return Buffer.byteLength(asText(value), 'utf8');
}

function finiteLimit(value, fallback = Infinity) {
  if (value === Infinity || String(value).trim().toLowerCase() === 'infinity') return Infinity;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function firstConfigured(opts, env, optionNames, envNames, fallback) {
  for (const name of optionNames) {
    if (opts && opts[name] !== undefined && opts[name] !== null && opts[name] !== '') return opts[name];
  }
  for (const name of envNames) {
    if (env && env[name] !== undefined && env[name] !== '') return env[name];
  }
  return fallback;
}

function resolveBudgetOptions(opts = {}) {
  const env = opts.env || process.env;
  const charsPerToken = finiteLimit(
    firstConfigured(
      opts,
      env,
      ['charsPerToken', 'tokenChars'],
      ['CONTEXT_CHARS_PER_TOKEN', 'CHARS_PER_TOKEN'],
      DEFAULT_CHARS_PER_TOKEN,
    ),
    DEFAULT_CHARS_PER_TOKEN,
  ) || DEFAULT_CHARS_PER_TOKEN;

  return {
    maxTextBytes: finiteLimit(
      firstConfigured(opts, env, ['maxTextBytes'], ['CONTEXT_MAX_TEXT_BYTES', 'MAX_TEXT_BYTES', 'SAKANA_MAX_TEXT_BYTES'], DEFAULT_MAX_TEXT_BYTES),
      DEFAULT_MAX_TEXT_BYTES,
    ),
    maxTotalTextBytes: finiteLimit(
      firstConfigured(
        opts,
        env,
        ['maxTotalTextBytes', 'maxAggregateTextBytes', 'maxContextTextBytes', 'textBudgetBytes'],
        [
          'CONTEXT_MAX_TOTAL_TEXT_BYTES',
          'MAX_TOTAL_TEXT_BYTES',
          'MAX_AGGREGATE_TEXT_BYTES',
          'MAX_CONTEXT_TEXT_BYTES',
          'MAX_TEXT_BUDGET_BYTES',
          'CONTEXT_TEXT_BUDGET_BYTES',
          'TEXT_BUDGET_BYTES',
          'SAKANA_MAX_TOTAL_TEXT_BYTES',
        ],
        DEFAULT_MAX_TOTAL_TEXT_BYTES,
      ),
      DEFAULT_MAX_TOTAL_TEXT_BYTES,
    ),
    maxAttachmentBytes: finiteLimit(
      firstConfigured(opts, env, ['maxAttachmentBytes'], ['CONTEXT_MAX_ATTACHMENT_BYTES', 'MAX_ATTACHMENT_BYTES', 'SAKANA_MAX_ATTACHMENT_BYTES'], DEFAULT_MAX_ATTACHMENT_BYTES),
      DEFAULT_MAX_ATTACHMENT_BYTES,
    ),
    maxTotalAttachmentBytes: finiteLimit(
      firstConfigured(
        opts,
        env,
        ['maxTotalAttachmentBytes', 'maxAggregateAttachmentBytes', 'attachmentBudgetBytes'],
        ['CONTEXT_MAX_TOTAL_ATTACHMENT_BYTES',
          'MAX_TOTAL_ATTACHMENT_BYTES',
          'MAX_AGGREGATE_ATTACHMENT_BYTES',
          'MAX_CONTEXT_ATTACHMENT_BYTES',
          'MAX_ATTACHMENT_BUDGET_BYTES',
          'CONTEXT_ATTACHMENT_BUDGET_BYTES',
          'ATTACHMENT_BUDGET_BYTES',
          'SAKANA_MAX_TOTAL_ATTACHMENT_BYTES',
        ],
        DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
      ),
      DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
    ),
    maxMultipartBytes: finiteLimit(
      firstConfigured(
        opts,
        env,
        ['maxMultipartBytes', 'maxMultipartPayloadBytes'],
        ['CONTEXT_MAX_MULTIPART_BYTES', 'MAX_MULTIPART_BYTES', 'MAX_MULTIPART_PAYLOAD_BYTES', 'SAKANA_MAX_MULTIPART_BYTES'],
        DEFAULT_MAX_MULTIPART_BYTES,
      ),
      DEFAULT_MAX_MULTIPART_BYTES,
    ),
    maxTotalBytes: finiteLimit(
      firstConfigured(opts, env, ['maxTotalBytes', 'maxContextBytes'], ['CONTEXT_MAX_TOTAL_BYTES', 'MAX_CONTEXT_BYTES'], Infinity),
      Infinity,
    ),
    charsPerToken,
    boundaryBytes: finiteLimit(
      firstConfigured(opts, env, ['multipartBoundaryBytes'], ['MULTIPART_BOUNDARY_BYTES'], DEFAULT_BOUNDARY_BYTES),
      DEFAULT_BOUNDARY_BYTES,
    ),
  };
}

function clipUtf8ByBytes(value, maxBytes = Infinity) {
  const text = asText(value);
  const limit = finiteLimit(maxBytes, Infinity);
  if (!Number.isFinite(limit) || utf8ByteLength(text) <= limit) return text;
  if (limit <= 0) return '';

  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > limit) break;
    bytes += characterBytes;
    end += character.length;
  }
  return text.slice(0, end);
}

function clipTextByBytes(value, maxBytes = Infinity) {
  const original = asText(value);
  const originalBytes = utf8ByteLength(original);
  const text = clipUtf8ByBytes(original, maxBytes);
  const bytes = utf8ByteLength(text);
  const clipped = text !== original;
  return {
    text,
    bytes,
    chars: countChars(text),
    originalBytes,
    originalChars: countChars(original),
    clipped,
    clippedBytes: originalBytes - bytes,
    code: clipped ? CLIP_CODES.TEXT_CLIPPED : '',
  };
}

function estimateTokens(value, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  const chars = typeof value === 'number' ? Math.max(0, value) : countChars(value);
  const divisor = finiteLimit(charsPerToken, DEFAULT_CHARS_PER_TOKEN) || DEFAULT_CHARS_PER_TOKEN;
  return chars / divisor;
}

function estimateTokensExact(value, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  const chars = typeof value === 'number' ? Math.max(0, value) : countChars(value);
  const divisor = finiteLimit(charsPerToken, DEFAULT_CHARS_PER_TOKEN) || DEFAULT_CHARS_PER_TOKEN;
  return chars / divisor;
}

function valueBytes(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  return utf8ByteLength(value);
}

function fieldEntries(fields) {
  if (!fields) return [];
  if (Array.isArray(fields)) return fields;
  if (typeof fields === 'object') return Object.entries(fields);
  return [['data', fields]];
}

function attachmentInfo(attachment) {
  if (Buffer.isBuffer(attachment) || attachment instanceof Uint8Array) {
    return { bytes: attachment.byteLength, name: 'file', mime: 'application/octet-stream' };
  }
  const number = Number(attachment?.bytes);
  const bytes = Number.isFinite(number) && number >= 0
    ? number
    : valueBytes(attachment?.buf || attachment?.data || '');
  return {
    bytes,
    name: attachment?.name || attachment?.filename || 'file',
    mime: attachment?.mime || attachment?.contentType || 'application/octet-stream',
  };
}

/**
 * Estimate the byte length of the browser-style multipart encoder used by the
 * upstream client. Boundary contents are fixed-length and do not affect size.
 */
function estimateMultipartBytes(input = {}, attachmentsArg) {
  let options = input;
  if (Array.isArray(input)) options = { attachments: input };
  if (typeof input === 'number') options = { textBytes: input, attachments: attachmentsArg || [] };
  options = options && typeof options === 'object' ? options : {};

  const boundaryLength = finiteLimit(options.boundaryBytes ?? options.boundaryLength, DEFAULT_BOUNDARY_BYTES);
  const boundary = typeof options.boundary === 'string' ? options.boundary : 'x'.repeat(boundaryLength);
  const fields = fieldEntries(options.fields);
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  let total = 0;
  const add = (value) => { total += valueBytes(value); };

  for (const [name, value] of fields) {
    add(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`);
    add(value);
    add('\r\n');
  }

  if (!fields.length && options.textBytes !== undefined) {
    add(`--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n`);
    total += Math.max(0, Number(options.textBytes) || 0);
    add('\r\n');
  }

  const files = attachments.length
    ? attachments
    : options.attachmentBytes === undefined
      ? []
      : [{ bytes: Math.max(0, Number(options.attachmentBytes) || 0) }];
  for (const attachment of files) {
    const file = attachmentInfo(attachment);
    add(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`);
    total += file.bytes;
    add('\r\n');
  }

  add(`--${boundary}--\r\n`);
  return total;
}

function serialiseStructured(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function measureContext({ messages = [], attachments = [], charsPerToken = DEFAULT_CHARS_PER_TOKEN, fields, boundaryBytes } = {}) {
  let textBytes = 0;
  let textChars = 0;
  let structuredBytes = 0;
  let structuredChars = 0;

  const addText = (value, structured = false) => {
    const text = serialiseStructured(value);
    const bytes = utf8ByteLength(text);
    const chars = countChars(text);
    if (structured) {
      structuredBytes += bytes;
      structuredChars += chars;
    } else {
      textBytes += bytes;
      textChars += chars;
    }
  };

  for (const message of messages || []) {
    let hasToolPart = false;
    for (const part of message?.parts || []) {
      if (!part) continue;
      if (part.kind === 'text') addText(part.text);
      else if (part.kind === 'tool_call') {
        hasToolPart = true;
        addText(part.name, true);
        addText(part.arguments, true);
      } else if (part.kind === 'tool_result') addText(part.content, true);
    }
    if (!hasToolPart && Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls) {
        addText(call?.function?.name || call?.name || '', true);
        addText(call?.function?.arguments ?? call?.arguments ?? call?.args ?? {}, true);
      }
    }
    if (message?.function_call && !hasToolPart) {
      addText(message.function_call.name || '', true);
      addText(message.function_call.arguments ?? message.function_call.args ?? {}, true);
    }
    if (message?.tool_result) addText(message.tool_result.content, true);
  }

  const attachmentBytes = (attachments || []).reduce((sum, attachment) => sum + attachmentInfo(attachment).bytes, 0);
  const chars = textChars + structuredChars;
  const estimatedMultipartBytes = estimateMultipartBytes({
    fields: fields || [['data', JSON.stringify(messages || [])]],
    attachments,
    boundaryBytes,
  });
  return {
    textBytes,
    textChars,
    structuredBytes,
    structuredChars,
    chars,
    estimatedTokens: estimateTokens(chars, charsPerToken),
    estimatedTokensExact: estimateTokensExact(chars, charsPerToken),
    estimatedTextTokens: estimateTokens(textChars, charsPerToken),
    attachmentBytes,
    estimatedMultipartBytes,
    multipartBytes: estimatedMultipartBytes,
  };
}

module.exports = {
  DEFAULT_MAX_TEXT_BYTES,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_TOTAL_TEXT_BYTES,
  DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
  DEFAULT_MAX_MULTIPART_BYTES,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_BOUNDARY_BYTES,
  BUDGET_ERROR_CODES,
  CLIP_CODES,
  utf8ByteLength,
  countChars,
  finiteLimit,
  resolveBudgetOptions,
  clipUtf8ByBytes,
  clipTextByBytes,
  estimateTokens,
  estimateTokensExact,
  estimateMultipartBytes,
  measureContext,
};
