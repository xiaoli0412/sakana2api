'use strict';

const crypto = require('crypto');

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32);
}

function messageFingerprint(messages = []) {
  return digest(JSON.stringify(messages));
}

function firstFingerprint(messages = []) {
  const first = messages.find((m) => m && m.role === 'user');
  return digest(JSON.stringify(first || null));
}

function recentFingerprint(messages = []) {
  return digest(JSON.stringify(messages.slice(-8)));
}

function makeContextSnapshot(normalized = {}) {
  const messages = normalized.messages || [];
  return {
    firstMessageFingerprint: normalized.firstMessageFingerprint || firstFingerprint(messages),
    recentClientHistoryFingerprint: normalized.recentHistoryFingerprint || messageFingerprint(messages),
    recentUserFingerprint: normalized.recentUserFingerprint || recentFingerprint(messages.filter((m) => m && m.role === 'user')),
    messageCount: messages.length,
    updatedAt: Date.now(),
  };
}

function firstUserFingerprint(messages = []) {
  return firstFingerprint(messages);
}

function isKnownHistory(stored = {}, client = {}) {
  if (!stored || !client) return false;
  if (stored.firstMessageFingerprint && client.firstMessageFingerprint && stored.firstMessageFingerprint !== client.firstMessageFingerprint) return false;
  if (stored.messageCount && client.messageCount && client.messageCount < stored.messageCount) return false;
  if (stored.recentClientHistoryFingerprint && client.recentClientHistoryFingerprint === stored.recentClientHistoryFingerprint) return true;
  if (stored.recentUserFingerprint && client.recentUserFingerprint === stored.recentUserFingerprint) return true;
  return !!stored.firstMessageFingerprint && stored.firstMessageFingerprint === client.firstMessageFingerprint &&
    (!stored.messageCount || !client.messageCount || client.messageCount > stored.messageCount);
}

function reuseDecision(stored) {
  return {
    action: 'reuse',
    conversationId: stored.conversationId,
    lastMessageId: stored.lastMessageId || '',
    sendClientHistory: false,
  };
}

function decideContext({ explicitId = '', stored = null, client = {}, historyMode = '', mode = '', history_mode = '', rebuildAttempted = false } = {}) {
  const requestedMode = String(historyMode || history_mode || mode || client.historyMode || client.history_mode || client.mode || '').toLowerCase();
  // An explicit conversation id normally means the client is sending only the
  // new turn. Full replay must be opted into explicitly so legacy clients do
  // not fork a healthy upstream conversation on the first follow-up.
  const isDelta = requestedMode === 'delta' || (!!explicitId && !requestedMode);

  if (explicitId) {
    if (!stored) return rebuildAttempted
      ? { action: 'fork', reason: 'CONTEXT-REBUILD-FAILED' }
      : { action: 'rebuild', reason: 'EXPLICIT_CONTEXT_MISSING' };
    if (stored.conversationId !== explicitId && !(stored.clientConversationIds || []).includes(explicitId)) {
      return { action: 'rebuild', reason: 'EXPLICIT_CONTEXT_MISMATCH' };
    }
    // An explicit id identifies the upstream conversation in delta mode; the
    // client may send only the latest turn, so its first fingerprint can differ.
    if (isDelta) return reuseDecision(stored);
  }
  if (!stored) return { action: 'new', reason: 'NO_STORED_CONTEXT' };
  if (client.messageCount && stored.messageCount && client.messageCount < stored.messageCount) {
    return { action: 'fork', reason: 'HISTORY_TRUNCATED' };
  }
  if (client.firstMessageFingerprint && stored.firstMessageFingerprint && client.firstMessageFingerprint !== stored.firstMessageFingerprint) {
    return { action: 'fork', reason: 'HISTORY_FORK' };
  }
  if (isKnownHistory(stored, client)) return reuseDecision(stored);
  if (client.recentClientHistoryFingerprint && stored.recentClientHistoryFingerprint && client.recentClientHistoryFingerprint !== stored.recentClientHistoryFingerprint &&
      client.messageCount === stored.messageCount) {
    return { action: 'fork', reason: 'HISTORY_FORK' };
  }
  return reuseDecision(stored);
}

module.exports = { digest, messageFingerprint, firstFingerprint, recentFingerprint, firstUserFingerprint, makeContextSnapshot, isKnownHistory, decideContext };
