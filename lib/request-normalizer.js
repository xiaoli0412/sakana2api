'use strict';

const crypto = require('crypto');
const { sniffMimeType } = require('./translate');
const { abortCode, abortError } = require('./abort');
const native = require('./native');
const {
  BUDGET_ERROR_CODES,
  CLIP_CODES,
  clipTextByBytes,
  estimateMultipartBytes,
  measureContext,
  resolveBudgetOptions,
} = require('./context-budget');

const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TEXT_BYTES = Infinity;
const DEFAULT_REMOTE_TIMEOUT_MS = 20_000;

const ATTACHMENT_ERROR_CODES = Object.freeze({
  ATTACHMENT_INVALID_DATA: 'ATTACHMENT_INVALID_DATA',
  ATTACHMENT_FETCH_FAILED: 'ATTACHMENT_FETCH_FAILED',
  ATTACHMENT_TOO_LARGE: 'ATTACHMENT_TOO_LARGE',
  ATTACHMENT_INVALID_SOURCE: 'ATTACHMENT_INVALID_SOURCE',
  ...BUDGET_ERROR_CODES,
});

class AttachmentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
    Object.assign(this, details);
  }
}

AttachmentError.codes = ATTACHMENT_ERROR_CODES;
AttachmentError.CODES = ATTACHMENT_ERROR_CODES;

function sha256(buf) {
  return native.sha256Hex(buf);
}

function dataUrlToBuffer(url) {
  const match = /^data:([^;,]*)(;[^,]*)?,([\s\S]*)$/i.exec(String(url || ''));
  if (!match) return null;
  const mime = match[1] || '';
  const metadata = match[2] || '';
  const data = match[3] || '';
  try {
    return {
      mime,
      buf: /;base64/i.test(metadata)
        ? Buffer.from(data, 'base64')
        : Buffer.from(decodeURIComponent(data), 'utf8'),
    };
  } catch (err) {
    throw new AttachmentError('ATTACHMENT_INVALID_DATA', 'invalid data URL attachment');
  }
}

function extensionForMime(mime) {
  const clean = String(mime || 'application/octet-stream').split(';')[0].split('/')[1] || 'bin';
  return clean.replace(/[^a-z0-9]+/gi, '') || 'bin';
}

function sourceToText(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string' && (!part.type || part.type === 'text')) return part.content;
  return '';
}

function inputMessages(body = {}) {
  if (Array.isArray(body.messages)) return body.messages;
  if (Array.isArray(body.contents)) {
    return body.contents.map((entry) => ({
      role: entry?.role === 'model' ? 'assistant' : (entry?.role || 'user'),
      content: entry?.parts ?? entry?.content ?? [],
    }));
  }
  if (Array.isArray(body.input)) {
    return body.input.map((entry) => typeof entry === 'string' ? { role: 'user', content: entry } : entry);
  }
  if (typeof body.input === 'string') return [{ role: 'user', content: body.input }];
  if (body.prompt !== undefined) return [{ role: 'user', content: String(body.prompt ?? '') }];
  return [];
}

function partAttachmentSource(part = {}) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'image_url' || part.type === 'image') {
    const source = part.source;
    if (source?.type === 'base64' && source.data) {
      return { data: source.data, mime: source.media_type || part.mime, base64: true, name: part.name };
    }
    if (source?.type === 'url' && source.url) return { url: source.url, mime: source.media_type || part.mime, name: part.name };
    const src = part.image_url?.url || part.url || '';
    if (/^data:/i.test(src)) return { dataUrl: src, mime: part.mime, name: part.name };
    if (/^https?:\/\//i.test(src)) return { url: src, mime: part.mime, name: part.name };
  }
  if (part.type === 'document' || part.type === 'file' || part.type === 'audio') {
    const source = part.source;
    if (source?.type === 'base64' && source.data) {
      return { data: source.data, mime: source.media_type || part.mime, base64: true, name: part.name };
    }
    if (source?.type === 'url' && source.url) return { url: source.url, mime: source.media_type || part.mime, name: part.name };
    const src = part.file_url || part.file_uri || part.fileData?.fileUri || part.file_data?.file_uri || part.url || '';
    if (/^data:/i.test(src)) return { dataUrl: src, mime: part.mime, name: part.name };
    if (/^https?:\/\//i.test(src)) return { url: src, mime: part.mime, name: part.name };
    if (part.data && typeof part.data === 'string') return { data: part.data, mime: part.mime, base64: true, name: part.name };
  }
  const inline = part.inlineData || part.inline_data;
  if (inline?.data) return { data: inline.data, mime: inline.mimeType || inline.mime_type, base64: true, name: part.name };
  const fileData = part.fileData || part.file_data;
  if (fileData?.fileUri || fileData?.file_uri) {
    return { url: fileData.fileUri || fileData.file_uri, mime: fileData.mimeType || fileData.mime_type, name: part.name };
  }
  return null;
}

async function fetchRemoteBuffer(url, opts) {
  const fetchRemote = opts.fetchRemote || fetch;
  const timeoutMs = opts.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  const maxBytes = resolveBudgetOptions(opts).maxAttachmentBytes;
  const parentSignal = opts.signal || opts.abortSignal || null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('attachment timeout'), { code: 'REQUEST-TIMEOUT' })), timeoutMs);
  const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  let response;
  try {
    response = await fetchRemote(url, { signal });
    const contentLength = Number(response?.headers?.get?.('content-length') || 0);
    if (!response || response.ok === false) {
      try { await response?.body?.cancel?.(); } catch {}
      throw new AttachmentError('ATTACHMENT_FETCH_FAILED', 'remote attachment request failed', { status: response?.status || 0 });
    }
    if (contentLength > maxBytes) {
      try { await response.body?.cancel?.(); } catch {}
      throw new AttachmentError('ATTACHMENT_TOO_LARGE', `attachment exceeds ${maxBytes} bytes`, { maxBytes });
    }
    let raw;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      const onAbort = () => { try { reader.cancel(signal.reason); } catch {} };
      signal.addEventListener?.('abort', onAbort, { once: true });
      try {
        for (;;) {
          if (signal.aborted) throw abortError(signal.reason);
          const { value, done } = await reader.read();
          if (signal.aborted) throw abortError(signal.reason);
          if (done) break;
          size += value?.byteLength || 0;
          if (size > maxBytes) {
            try { await reader.cancel(); } catch {}
            throw new AttachmentError('ATTACHMENT_TOO_LARGE', `attachment exceeds ${maxBytes} bytes`, { maxBytes });
          }
          if (value?.byteLength) chunks.push(Buffer.from(value));
        }
      } finally {
        signal.removeEventListener?.('abort', onAbort);
        try { await reader.cancel(); } catch {}
      }
      raw = Buffer.concat(chunks, size);
    } else {
      const declared = Number(response?.headers?.get?.('content-length') || 0);
      if (!Number.isFinite(declared) || declared <= 0 || declared > maxBytes) {
        try { await response.body?.cancel?.(); } catch {}
        throw new AttachmentError('ATTACHMENT_TOO_LARGE', `attachment exceeds ${maxBytes} bytes`, { maxBytes });
      }
      if (signal.aborted) throw abortError(signal.reason);
      raw = Buffer.from(await response.arrayBuffer());
      if (signal.aborted) throw abortError(signal.reason);
      if (raw.length > maxBytes) throw new AttachmentError('ATTACHMENT_TOO_LARGE', `attachment exceeds ${maxBytes} bytes`, { maxBytes });
    }
    return { buf: raw, mime: response.headers?.get?.('content-type') || '' };
  } catch (err) {
    const code = abortCode(signal.reason || err, '');
    if (code === 'REQUEST-TIMEOUT') throw new AttachmentError('REQUEST-TIMEOUT', 'attachment request timed out', { cause: err });
    if (code === 'SERVER-SHUTDOWN') throw new AttachmentError('SERVER-SHUTDOWN', 'server is shutting down', { cause: err });
    if (code === 'REQUEST-ABORTED') throw new AttachmentError('REQUEST-ABORTED', 'request aborted', { cause: err });
    if (err instanceof AttachmentError) throw err;
    throw new AttachmentError('ATTACHMENT_FETCH_FAILED', 'remote attachment request failed', { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

async function normalizeAttachment(source, order, opts = {}) {
  const maxBytes = resolveBudgetOptions(opts).maxAttachmentBytes;
  let buf;
  let mime = source.mime || '';
  let name = source.name || '';
  if (source.dataUrl) {
    const decoded = dataUrlToBuffer(source.dataUrl);
    if (!decoded) throw new AttachmentError('ATTACHMENT_INVALID_DATA', 'invalid data URL attachment');
    buf = decoded.buf;
    mime ||= decoded.mime;
  } else if (source.url) {
    const fetched = await fetchRemoteBuffer(source.url, opts);
    buf = fetched.buf;
    mime ||= fetched.mime;
    if (!name) name = source.url.split('/').pop()?.split('?')[0] || '';
  } else if (source.data) {
    buf = source.base64 ? Buffer.from(source.data, 'base64') : Buffer.from(source.data);
  } else {
    throw new AttachmentError('ATTACHMENT_INVALID_SOURCE', 'attachment has no data source');
  }
  if (buf.length > maxBytes) throw new AttachmentError('ATTACHMENT_TOO_LARGE', `attachment exceeds ${maxBytes} bytes`, { maxBytes });
  if (!mime || mime === 'application/octet-stream') mime = sniffMimeType(buf);
  mime = String(mime || 'application/octet-stream').split(';')[0].toLowerCase();
  if (!name) name = `attachment-${order + 1}.${extensionForMime(mime)}`;
  const digest = sha256(buf);
  const id = `att_${digest.slice(0, 16)}_${order}`;
  return { id, name, mime, source: source.url ? 'remote' : 'inline', bytes: buf.length, sha256: digest, order, buf };
}

function cloneStructured(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneStructured);
  const result = {};
  for (const [key, entry] of Object.entries(value)) result[key] = cloneStructured(entry);
  return result;
}

function structuredToolCall(call = {}) {
  const fn = call.function || call;
  return {
    kind: 'tool_call',
    id: call.id || call.tool_call_id || '',
    type: call.type || 'function',
    name: fn.name || call.name || '',
    arguments: fn.arguments ?? fn.args ?? call.arguments ?? call.args ?? fn.input ?? call.input ?? {},
  };
}

function structuredToolResult(result = {}) {
  return {
    kind: 'tool_result',
    id: result.tool_use_id || result.tool_call_id || result.id || result.name || '',
    name: result.name || '',
    content: result.content ?? result.response ?? result.result ?? result,
  };
}

function structuredPart(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'tool_result' || part.tool_result || part.functionResponse || part.function_response) {
    return structuredToolResult(part.tool_result || part.functionResponse || part.function_response || part);
  }
  if (part.type === 'tool_use' || part.functionCall || part.function_call || part.tool_call) {
    return structuredToolCall(part.tool_call || part.functionCall || part.function_call || part);
  }
  return null;
}

function copyMessageMetadata(raw) {
  const metadata = {
    name: raw.name || '',
    tool_call_id: raw.tool_call_id || raw.toolCallId || '',
  };
  if (Array.isArray(raw.tool_calls)) metadata.tool_calls = cloneStructured(raw.tool_calls);
  if (raw.function_call && typeof raw.function_call === 'object') metadata.function_call = cloneStructured(raw.function_call);
  if (raw.tool_result && typeof raw.tool_result === 'object') metadata.tool_result = cloneStructured(raw.tool_result);
  return metadata;
}

function clippingDetails(clipped, maxBytes, messageIndex, partIndex) {
  if (!clipped.clipped) return null;
  return {
    code: CLIP_CODES.TEXT_CLIPPED,
    messageIndex,
    partIndex,
    originalBytes: clipped.originalBytes,
    bytes: clipped.bytes,
    clippedBytes: clipped.clippedBytes,
    originalChars: clipped.originalChars,
    chars: clipped.chars,
    maxBytes,
  };
}

function addTextPart(parts, text, maxBytes, clipping, messageIndex, partIndex) {
  const clipped = clipTextByBytes(text, maxBytes);
  const part = { kind: 'text', text: clipped.text };
  // Keep the legacy part shape for ordinary text. Metadata is additive and
  // appears only when clipping occurred, making clipping deterministic and
  // easy for callers to audit without changing existing fingerprints.
  const details = clippingDetails(clipped, maxBytes, messageIndex, partIndex);
  if (details) {
    part.clipped = true;
    part.bytes = details.bytes;
    part.originalBytes = details.originalBytes;
    part.clipping = details;
    clipping.push(details);
  }
  parts.push(part);
  return clipped;
}

function addToolCallPart(parts, call) {
  const normalized = structuredToolCall(call);
  parts.push(normalized);
  return normalized;
}

function addToolResultPart(parts, result) {
  const normalized = structuredToolResult(result);
  parts.push(normalized);
  return normalized;
}

function hasStructuredMessage(metadata) {
  return !!(
    metadata.tool_call_id ||
    (Array.isArray(metadata.tool_calls) && metadata.tool_calls.length) ||
    metadata.function_call ||
    metadata.tool_result
  );
}

async function normalizeRequestBody(body = {}, opts = {}) {
  const budgetOptions = resolveBudgetOptions(opts);
  const attachments = [];
  const messages = [];
  const clipping = [];
  let attachmentOrder = 0;
  let totalTextBytes = 0;
  let originalTextBytes = 0;
  let totalAttachmentBytes = 0;

  for (const [messageIndex, raw] of inputMessages(body).entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const role = raw.role === 'model' ? 'assistant' : (raw.role || 'user');
    const content = raw.content ?? raw.parts ?? '';
    const parts = [];
    const metadata = copyMessageMetadata(raw);
    const list = content === null || content === undefined ? [] : (Array.isArray(content) ? content : [content]);
    let partIndex = 0;

    for (const part of list) {
      const structured = structuredPart(part);
      if (structured) {
        if (structured.kind === 'tool_call') addToolCallPart(parts, structured);
        else addToolResultPart(parts, structured);
        partIndex++;
        continue;
      }

      const text = sourceToText(part);
      if (text) {
        const clipped = addTextPart(parts, text, budgetOptions.maxTextBytes, clipping, messageIndex, partIndex++);
        totalTextBytes += clipped.bytes;
        originalTextBytes += clipped.originalBytes;
        continue;
      }

      const source = partAttachmentSource(part);
      if (source) {
        const attachment = await normalizeAttachment(source, attachmentOrder++, { ...opts, ...budgetOptions });
        totalAttachmentBytes += attachment.bytes;
        if (totalAttachmentBytes > budgetOptions.maxTotalAttachmentBytes) {
          throw new AttachmentError(
            ATTACHMENT_ERROR_CODES.ATTACHMENT_BUDGET_EXCEEDED,
            `attachments exceed ${budgetOptions.maxTotalAttachmentBytes} bytes`,
            {
              budget: budgetOptions.maxTotalAttachmentBytes,
              maxTotalAttachmentBytes: budgetOptions.maxTotalAttachmentBytes,
              attachmentBytes: totalAttachmentBytes,
              attachments: attachments.length + 1,
            },
          );
        }
        attachments.push(attachment);
        parts.push({ kind: 'attachment', attachment: { ...attachment, buf: undefined } });
        partIndex++;
      }
    }

    // OpenAI-style structured calls live beside content. Keep them both in
    // their native field and in ordered parts so callers can consume either
    // representation without losing IDs or argument fragments.
    if (Array.isArray(metadata.tool_calls)) {
      for (const call of metadata.tool_calls) addToolCallPart(parts, call);
    } else if (metadata.function_call) {
      addToolCallPart(parts, metadata.function_call);
    }

    const shouldKeep = parts.length || hasStructuredMessage(metadata);
    if (shouldKeep) messages.push({ role, parts, ...metadata });
  }

  if (Number.isFinite(budgetOptions.maxTotalTextBytes) && totalTextBytes > budgetOptions.maxTotalTextBytes) {
    if (!opts.clipTextToBudget) {
      throw new AttachmentError(
        ATTACHMENT_ERROR_CODES.TEXT_BUDGET_EXCEEDED,
        `text exceeds ${budgetOptions.maxTotalTextBytes} bytes`,
        {
          budget: budgetOptions.maxTotalTextBytes,
          maxTotalTextBytes: budgetOptions.maxTotalTextBytes,
          textBytes: totalTextBytes,
          originalTextBytes,
        },
      );
    }

    // Apply a second deterministic pass in message/part order. This retains
    // the existing clipping behavior while enforcing the aggregate limit.
    let remaining = budgetOptions.maxTotalTextBytes;
    totalTextBytes = 0;
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const message = messages[messageIndex];
      for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
        const part = message.parts[partIndex];
        if (part.kind !== 'text') continue;
        const prior = part.text;
        const clipped = clipTextByBytes(prior, remaining);
        if (clipped.clipped) {
          const details = {
            code: CLIP_CODES.TEXT_CLIPPED,
            messageIndex,
            partIndex,
            reason: 'aggregate_budget',
            originalBytes: clipped.originalBytes,
            bytes: clipped.bytes,
            clippedBytes: clipped.clippedBytes,
            originalChars: clipped.originalChars,
            chars: clipped.chars,
            maxBytes: remaining,
            maxTotalTextBytes: budgetOptions.maxTotalTextBytes,
          };
          part.text = clipped.text;
          part.clipped = true;
          part.bytes = clipped.bytes;
          part.originalBytes = clipped.originalBytes;
          part.clipping = details;
          clipping.push(details);
        }
        totalTextBytes += clipped.bytes;
        remaining -= clipped.bytes;
      }
    }
  }

  const measurements = measureContext({
    messages,
    attachments,
    charsPerToken: budgetOptions.charsPerToken,
    boundaryBytes: budgetOptions.boundaryBytes,
  });
  // `measureContext` measures structured arguments independently of visible
  // text; aggregate text budget is intentionally about text parts only.
  measurements.textBytes = totalTextBytes;
  measurements.originalTextBytes = originalTextBytes;
  measurements.attachmentBytes = totalAttachmentBytes;
  measurements.totalBytes = measurements.textBytes + measurements.structuredBytes + measurements.attachmentBytes;
  measurements.limits = {
    maxTextBytes: budgetOptions.maxTextBytes,
    maxTotalTextBytes: budgetOptions.maxTotalTextBytes,
    maxAttachmentBytes: budgetOptions.maxAttachmentBytes,
    maxTotalAttachmentBytes: budgetOptions.maxTotalAttachmentBytes,
    maxMultipartBytes: budgetOptions.maxMultipartBytes,
    maxTotalBytes: budgetOptions.maxTotalBytes,
  };
  measurements.clipping = clipping;
  measurements.clipped = clipping.length > 0;
  measurements.estimatedMultipartBytes = estimateMultipartBytes({
    fields: [['data', JSON.stringify(messages)]],
    attachments,
    boundaryBytes: budgetOptions.boundaryBytes,
  });
  measurements.multipartBytes = measurements.estimatedMultipartBytes;

  if (Number.isFinite(budgetOptions.maxTotalBytes) && measurements.totalBytes > budgetOptions.maxTotalBytes) {
    throw new AttachmentError(
      ATTACHMENT_ERROR_CODES.CONTEXT_BUDGET_EXCEEDED,
      `context exceeds ${budgetOptions.maxTotalBytes} bytes`,
      {
        budget: budgetOptions.maxTotalBytes,
        maxTotalBytes: budgetOptions.maxTotalBytes,
        totalBytes: measurements.totalBytes,
        textBytes: measurements.textBytes,
        attachmentBytes: measurements.attachmentBytes,
      },
    );
  }
  if (Number.isFinite(budgetOptions.maxMultipartBytes) && measurements.estimatedMultipartBytes > budgetOptions.maxMultipartBytes) {
    throw new AttachmentError(
      ATTACHMENT_ERROR_CODES.MULTIPART_BUDGET_EXCEEDED,
      `multipart payload exceeds ${budgetOptions.maxMultipartBytes} bytes`,
      {
        budget: budgetOptions.maxMultipartBytes,
        maxMultipartBytes: budgetOptions.maxMultipartBytes,
        multipartBytes: measurements.estimatedMultipartBytes,
        textBytes: measurements.textBytes,
        attachmentBytes: measurements.attachmentBytes,
      },
    );
  }

  const result = {
    messages,
    attachments,
    fingerprint: fingerprintMessages(messages),
    // Additive aliases make measurements available without forcing existing
    // callers to know which future budget field name is canonical.
    budget: measurements,
    measurements,
    textBytes: measurements.textBytes,
    attachmentBytes: measurements.attachmentBytes,
    estimatedTokens: measurements.estimatedTokens,
    estimatedMultipartBytes: measurements.estimatedMultipartBytes,
    multipartBytes: measurements.estimatedMultipartBytes,
    clipping,
  };
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function fingerprintMessages(messages = []) {
  const semantic = messages.map((message) => ({
    role: message.role,
    name: message.name || '',
    tool_call_id: message.tool_call_id || '',
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined,
    function_call: message.function_call || undefined,
    tool_result: message.tool_result || undefined,
    parts: (message.parts || []).map((part) => {
      if (part.kind === 'attachment') {
        return {
          kind: 'attachment',
          attachment: {
            id: part.attachment.id,
            name: part.attachment.name,
            mime: part.attachment.mime,
            sha256: part.attachment.sha256,
            order: part.attachment.order,
          },
        };
      }
      if (part.kind === 'text') return { kind: 'text', text: part.text };
      if (part.kind === 'tool_call') return { kind: 'tool_call', id: part.id, type: part.type, name: part.name, arguments: part.arguments };
      if (part.kind === 'tool_result') return { kind: 'tool_result', id: part.id, name: part.name, content: part.content };
      return part;
    }),
  }));
  return crypto.createHash('sha256').update(JSON.stringify(canonical(semantic))).digest('hex').slice(0, 32);
}

module.exports = {
  AttachmentError,
  ATTACHMENT_ERROR_CODES,
  normalizeRequestBody,
  normalizeMessages: inputMessages,
  normalizeAttachment,
  fingerprintMessages,
  // Expose the budget primitives from the compatibility entry point as well;
  // callers that only imported this module need not take a new dependency.
  clipTextByBytes,
  estimateMultipartBytes,
  measureContext,
  resolveBudgetOptions,
};
