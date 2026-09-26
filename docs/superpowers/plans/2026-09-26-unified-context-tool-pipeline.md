# Unified Context and Tool Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved unified context, multimodal, tool, reasoning, search, and file-event pipeline with OpenAI/AstrBot compatibility first and synchronized Gemini/Anthropic adapters.

**Architecture:** Add focused normalization modules before `translate.js`, enrich `ContextStore` with fingerprints and fork decisions, and introduce an internal event stream that adapters convert to OpenAI, Gemini, and Anthropic output. Preserve existing Sakana protocol, account pooling, server-side sandbox continuation, and additive response fields.

**Tech Stack:** Node.js 22 CommonJS/ES modules, native fetch, Buffer, existing Playwright/Sakana upstream client, executable `.mjs` tests, Python OpenAI SDK integration scripts.

---

## File Map

- Create `lib/request-normalizer.js`: common messages, attachment normalization, limits, MIME/data URL/remote source handling.
- Create `lib/context-policy.js`: client history fingerprints, server/client consistency and fork decisions.
- Create `lib/events.js`: internal turn event types, event helpers, and bounded event aggregation.
- Create `lib/tool-state.js`: indexed tool-call state machine and tool-result identity.
- Modify `lib/context.js`: persist richer fingerprints and conversation leaf metadata while retaining legacy lookup/save signatures.
- Modify `lib/translate.js`: use request normalizer, emit internal-compatible metadata, improve multimodal markers and tool prompt construction.
- Modify `lib/upstream.js`: expose bounded remote attachment fetching and file output URL helpers.
- Modify `server.js`: apply context policy, drive native continuation through one state machine, update context leaves, and map internal metadata to OpenAI responses.
- Modify `lib/gemini.js`: map structured reasoning/search/file/tool metadata through Gemini output.
- Modify `lib/anthropic.js`: map structured reasoning/search/file/tool metadata through Anthropic blocks/events.
- Create `tests/request-normalizer.test.mjs`: request/attachment normalization and limits.
- Create `tests/context-policy.test.mjs`: history fingerprints, known-history acceptance, and fork decisions.
- Create `tests/tool-state.test.mjs`: fragmented and parallel tool calls.
- Create `tests/events.test.mjs`: event ordering, usage-once, reasoning/search/file aggregation.
- Create `tests/adapter-contract.test.mjs`: OpenAI/Gemini/Anthropic mapping contracts.
- Extend `tests/context.test.mjs`, `tests/translate.test.mjs`, and `tests/tools-search.test.mjs` for regression coverage.

---

## Phase 1: Request Normalization and Mixed Context

### Task 1: Build the common attachment and message normalizer

**Files:**
- Create: `lib/request-normalizer.js`
- Create: `tests/request-normalizer.test.mjs`

- [ ] **Step 1: Write failing tests for data URLs, base64, remote sources, and mixed ordering**

Test `normalizeRequestBody(body, opts)` with OpenAI image content, Anthropic image/document blocks, Gemini `inlineData`/`fileData`, plain text, and audio. Assert the normalized message list preserves source order and each attachment has `{ name, mime, source, order }`. Assert data URL MIME is decoded and missing/octet-stream MIME is sniffed from magic bytes.

Also test remote URLs with an injected `fetchRemote` stub returning a response whose `arrayBuffer()` exceeds `maxBytes`; expect an error with code `ATTACHMENT_TOO_LARGE`.

- [ ] **Step 2: Run the focused test to verify it fails**

```bash
node tests/request-normalizer.test.mjs
```

Expected: FAIL because `lib/request-normalizer.js` does not exist.

- [ ] **Step 3: Implement bounded attachment normalization**

Implement these exports:

```js
async function normalizeRequestBody(body, opts = {}) {}
function normalizeMessages(body) {}
function normalizeAttachment(part, order, opts = {}) {}
function fingerprintMessages(messages) {}
module.exports = { normalizeRequestBody, normalizeMessages, normalizeAttachment, fingerprintMessages };
```

Use defaults `maxAttachmentBytes=20*1024*1024`, `remoteTimeoutMs=20000`, `maxTextBytes=50000`. Accept an injected `fetchRemote(url, { signal })` for tests; production uses native `fetch` with `AbortSignal.timeout`. Decode data URLs and base64 into Buffers, sniff MIME when missing, compute SHA-256, and throw explicit `ATTACHMENT_*` errors instead of dropping invalid sources.

- [ ] **Step 4: Add stable message and attachment fingerprints**

Fingerprint only semantic content: role, text, attachment SHA-256/name/mime/order, tool call IDs/names/arguments, and tool results. Exclude `stream`, API keys, conversation IDs, and timestamps. Return a short SHA-256 hex string.

- [ ] **Step 5: Run the focused test to verify it passes**

```bash
node tests/request-normalizer.test.mjs
```

Expected: PASS for all attachment formats, order preservation, size limits, MIME sniffing, and stable fingerprints.

- [ ] **Step 6: Commit Phase 1 normalizer**

```bash
git add lib/request-normalizer.js tests/request-normalizer.test.mjs
git commit -m "feat: normalize multimodal requests and attachments"
```

### Task 2: Add mixed context fingerprints and fork policy

**Files:**
- Create: `lib/context-policy.js`
- Modify: `lib/context.js:1-125`
- Create: `tests/context-policy.test.mjs`
- Extend: `tests/context.test.mjs`

- [ ] **Step 1: Write failing policy tests**

Test `decideContext({ explicitId, stored, clientFingerprint, firstFingerprint, recentFingerprint })` with these cases:

1. Explicit ID matches stored conversation: `reuse`.
2. No explicit ID and first fingerprint matches: `reuse`.
3. Client history is a suffix extension of stored history: `reuse` with `sendClientHistory=false`.
4. First message or tool-call ID differs: `fork` with reason `HISTORY_FORK`.
5. Explicit ID is absent from store: `rebuild` once with reason `EXPLICIT_CONTEXT_MISSING`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
node tests/context-policy.test.mjs
```

Expected: FAIL because policy module and richer context fields are missing.

- [ ] **Step 3: Implement policy and context entry fields**

Implement:

```js
function decideContext(input) {}
function isKnownHistory(stored, client) {}
function makeContextSnapshot(normalized) {}
module.exports = { decideContext, isKnownHistory, makeContextSnapshot };
```

Extend context entries with `firstMessageFingerprint`, `recentClientHistoryFingerprint`, `recentUserFingerprint`, `updatedAt`, `forks`, and `rebuilds`. Keep existing `conversationId`, `accountId`, `lastMessageId`, TTL, capacity, string lookup, and request lookup behavior.

- [ ] **Step 4: Update save/lookup to preserve the richer snapshot**

Allow `ContextStore.save(req, body, conversationId, lastMessageId, accountId, snapshot)` while accepting the old five-argument shape. Add `getByConversationId(id)` and `updateLeaf(id, lastMessageId, snapshot)` without exposing cookies or tokens.

- [ ] **Step 5: Run context tests**

```bash
node tests/context-policy.test.mjs
node tests/context.test.mjs
```

Expected: PASS, including all existing legacy context tests.

- [ ] **Step 6: Commit mixed context policy**

```bash
git add lib/context.js lib/context-policy.js tests/context-policy.test.mjs tests/context.test.mjs
git commit -m "feat: add mixed client and server context policy"
```

### Task 3: Integrate request normalization and context policy into the chat pipeline

**Files:**
- Modify: `lib/translate.js:153-403`
- Modify: `server.js:260-279,367-560,768-955`
- Modify: `lib/cache.js:17-24`
- Extend: `tests/translate.test.mjs`, `tests/context-policy.test.mjs`

- [ ] **Step 1: Add failing integration assertions**

Assert that a full client history with a stored conversation is not duplicated into the upstream prompt, while a changed first user message returns a fork decision. Assert cache keys include semantic message/attachment fingerprints but continue ignoring `conversation_id` and `stream`.

- [ ] **Step 2: Run regression tests to capture the failing behavior**

```bash
node tests/translate.test.mjs
node tests/context-policy.test.mjs
```

Expected: new integration assertions fail before pipeline integration.

- [ ] **Step 3: Apply normalizer before Sakana request construction**

At each chat entry, normalize body messages before `openaiRequestToSakana`. Preserve `sakanaReq` compatibility fields while adding:

```js
normalizedMessages,
messageFingerprint,
firstMessageFingerprint,
recentHistoryFingerprint,
attachments,
```

Use normalized attachment order to construct `files`, and replace the current long-prompt first/last slicing with ordered chunk markers from the normalizer. Preserve `TOOL_PROMPT=0`, model parsing, and search/thinking mutual exclusion.

- [ ] **Step 4: Apply context decision before bootstrap**

Use explicit ID, stored entry, and fingerprints to decide `reuse`, `fork`, or `rebuild`. On `reuse`, use the stored conversation and leaf without resending known history. On `fork`, clear only the stale mapping and create a new conversation. On `rebuild`, retry once and then return a stable `CONTEXT-REBUILD-FAILED` error.

- [ ] **Step 5: Save and update context after all response paths**

Save snapshots after non-stream completion, stream completion/error, and every native continuation leaf update. Ensure the `x-conversation-id` header and JSON `conversation_id` use the final active conversation.

- [ ] **Step 6: Update cache key semantic inputs**

Make cache keys use normalized semantic messages and attachment fingerprints while excluding conversation IDs, stream mode, API keys, and transient tool status. Do not cache tool-call responses or responses with file outputs.

- [ ] **Step 7: Run focused and existing tests**

```bash
node tests/request-normalizer.test.mjs
node tests/context-policy.test.mjs
node tests/context.test.mjs
node tests/translate.test.mjs
```

Expected: all pass, including existing multimodal, tool-result, and long-context assertions.

- [ ] **Step 8: Commit pipeline integration**

```bash
git add lib/translate.js server.js lib/cache.js tests/translate.test.mjs tests/context-policy.test.mjs
git commit -m "feat: integrate normalized multimodal context handling"
```

---

## Phase 2: Internal Events, Tools, Reasoning, Search, and Files

### Task 4: Add internal event definitions and bounded aggregation

**Files:**
- Create: `lib/events.js`
- Create: `tests/events.test.mjs`

- [ ] **Step 1: Write failing event tests**

Test event constructors and `TurnEventBuffer` with mixed content, model reasoning, search status/source, file output, finish, and duplicate usage. Assert original event order is preserved, search sources deduplicate by title+URL, safety-stop text is removed once, and only one final usage event is emitted.

- [ ] **Step 2: Run tests to verify they fail**

```bash
node tests/events.test.mjs
```

Expected: FAIL because the event module is missing.

- [ ] **Step 3: Implement internal events**

Implement constructors:

```js
contentDelta(text, meta = {})
reasoningDelta(text, kind = 'model', meta = {})
searchStarted(query)
searchSource(source)
toolCallStart(call)
toolCallDelta(call)
toolCallEnd(call)
fileOutput(file)
finish(reason)
usage(stats)
```

Implement `TurnEventBuffer.push(event)`, `.finish()`, `.snapshot()`, and `.toOpenAiChunks()`. Enforce bounded source count, bounded file metadata, one finish, and one usage tail.

- [ ] **Step 4: Run event tests**

```bash
node tests/events.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit event layer**

```bash
git add lib/events.js tests/events.test.mjs
git commit -m "feat: add shared turn event model"
```

### Task 5: Replace ad hoc tool aggregation with indexed tool state

**Files:**
- Create: `lib/tool-state.js`
- Modify: `lib/translate.js:497-845`
- Modify: `server.js:174-258,500-627,879-955`
- Create: `tests/tool-state.test.mjs`
- Extend: `tests/tools-search.test.mjs`

- [ ] **Step 1: Write failing fragmented and parallel tool tests**

Test `ToolCallState` with two calls whose argument fragments arrive interleaved by upstream index. Assert stable IDs, indexes, names, complete JSON arguments, and one `tool_call_end` per call. Test native `functions.*` calls remain server-side and undeclared client tools remain suppressed.

- [ ] **Step 2: Run tests to verify they fail**

```bash
node tests/tool-state.test.mjs
```

Expected: FAIL because indexed tool state is absent.

- [ ] **Step 3: Implement `ToolCallState`**

Implement:

```js
class ToolCallState {
  start(raw) {}
  delta(raw) {}
  result(raw) {}
  end(indexOrId) {}
  clientCalls() {}
  nativeRound() {}
}
module.exports = { ToolCallState };
```

Use `Map` by ID and index, preserve input fragments exactly, normalize object arguments with JSON.stringify once, and expose immutable snapshots for adapters.

- [ ] **Step 4: Make `NdjsonTranslator` emit events and OpenAI-compatible chunks**

Keep `line()` and `finish()` compatibility for current tests, but route tool, reasoning, search, file, finish, and usage state through `ToolCallState`/`TurnEventBuffer`. Preserve existing `reasoning_content`, `citations`, `tool_calls`, usage tail, safety stripping, and JSON tool extraction behavior.

- [ ] **Step 5: Unify native continuation state**

Replace duplicated non-stream/stream continuation loops with one bounded helper that returns `{ text, reasoning, toolCalls, events, lastMessageId, translator }`. Fix the streaming continuation translator binding so the active translator can be replaced without assigning to a `const`, and update context leaf after each continuation.

- [ ] **Step 6: Run tool and existing tests**

```bash
node tests/tool-state.test.mjs
node tests/tools-search.test.mjs
node tests/translate.test.mjs
```

Expected: PASS, including AstrBot-style fragmented arguments and parallel calls.

- [ ] **Step 7: Commit tool state and continuation changes**

```bash
git add lib/tool-state.js lib/events.js lib/translate.js server.js tests/tool-state.test.mjs tests/tools-search.test.mjs tests/translate.test.mjs
git commit -m "feat: stabilize indexed tool calls and native continuation"
```

### Task 6: Normalize reasoning, search, and file output events

**Files:**
- Modify: `lib/events.js`
- Modify: `lib/translate.js:524-845`
- Modify: `server.js:500-627,879-955`
- Modify: `lib/upstream.js:147-227`
- Extend: `tests/events.test.mjs`, `tests/tools-search.test.mjs`

- [ ] **Step 1: Write failing reasoning/search/file assertions**

Assert model reasoning, `<thinking>` content, search start, search source snippet, and file events produce distinct internal event kinds while OpenAI compatibility still exposes `reasoning_content`, `citations`, `file_output`, and one finish/usage tail. Assert source duplicates are removed and file metadata includes a generated download URL when conversation ID and SHA exist.

- [ ] **Step 2: Implement event normalization**

Map Sakana `reasoning`, `<thinking>`, search `toolCall/toolResult`, and `file` updates to events. Strip safety text in the event layer. Preserve source `title`, `url`, `snippet/content`, and file `name`, `sha`, `mime`, `size` where available.

- [ ] **Step 3: Add upstream file URL helper**

Add:

```js
function fileOutputUrl(conversationId, sha) {
  return conversationId && sha ? `${BASE}/api/conversation/${encodeURIComponent(conversationId)}/output/${encodeURIComponent(sha)}` : '';
}
```

Use it only for response metadata; do not fetch file output eagerly.

- [ ] **Step 4: Update OpenAI non-stream and stream output**

Non-stream responses include additive `files`, `citations`, and optional `search_results`. Streaming emits file metadata/citations on the corresponding chunk and sends exactly one usage tail when requested. Preserve existing response field names and finish reasons.

- [ ] **Step 5: Run focused tests**

```bash
node tests/events.test.mjs
node tests/tools-search.test.mjs
node tests/translate.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit reasoning/search/file events**

```bash
git add lib/events.js lib/translate.js server.js lib/upstream.js tests/events.test.mjs tests/tools-search.test.mjs tests/translate.test.mjs
git commit -m "feat: expose structured reasoning search and file events"
```

---

## Phase 3: Gemini and Anthropic Adapter Contracts

### Task 7: Add shared adapter contract tests

**Files:**
- Create: `tests/adapter-contract.test.mjs`
- Modify: `lib/events.js`

- [ ] **Step 1: Write failing contract fixtures**

Create one internal event fixture containing model reasoning, search status/source, two parallel tool calls, file output, content, finish, and usage. Assert each adapter receives the same semantic values and that usage/finish are not duplicated.

- [ ] **Step 2: Run contract tests to verify missing mappings**

```bash
node tests/adapter-contract.test.mjs
```

Expected: FAIL until adapter mapping functions are added.

- [ ] **Step 3: Add adapter-neutral projection helpers**

Export `toOpenAiEvent`, `toGeminiEvent`, and `toAnthropicEvent` from `lib/events.js`. Each projection must be additive and preserve source IDs, call indexes, citations, file metadata, and reasoning kind where the target protocol permits it.

- [ ] **Step 4: Run contract tests**

```bash
node tests/adapter-contract.test.mjs
```

Expected: PASS.

### Task 8: Upgrade Gemini and Anthropic adapters

**Files:**
- Modify: `lib/gemini.js:130-287`
- Modify: `lib/anthropic.js:110-270`
- Modify: `server.js:677-766,995-1021`
- Extend: `tests/adapter-contract.test.mjs`, `tests/tools-search.test.mjs`

- [ ] **Step 1: Add failing adapter assertions**

Assert Gemini streaming emits thought parts for model/search reasoning, function calls preserve indexes and arguments, source metadata is present, and file output is not silently dropped. Assert Anthropic streaming emits valid thinking/text/tool blocks with one message stop and usage.

- [ ] **Step 2: Implement Gemini event projection**

Update `openAiCompletionToGemini`, `openAiChunkToGemini`, and `createGeminiResponseAdapter` to consume structured metadata while preserving current `candidates`, `thought`, `functionCall`, `finishReason`, and `usageMetadata` fields. Emit grounding/source metadata when available.

- [ ] **Step 3: Implement Anthropic event projection**

Update `chatToAnthropicNonStream`, `AnthropicStreamer`, and request conversion so thinking, tool blocks, file metadata, and usage map without duplicate `message_stop` or block stops. Keep current `tool_use/tool_result` request compatibility.

- [ ] **Step 4: Run adapter and existing tests**

```bash
node tests/adapter-contract.test.mjs
node tests/tools-search.test.mjs
node tests/translate.test.mjs
npm test
```

Expected: all pass.

- [ ] **Step 5: Commit adapter synchronization**

```bash
git add lib/events.js lib/gemini.js lib/anthropic.js server.js tests/adapter-contract.test.mjs tests/tools-search.test.mjs
 git commit -m "feat: synchronize Gemini and Anthropic event adapters"
```

---

## Task 9: Endpoint-level multimodal and AstrBot verification

**Files:**
- Extend: `tests/astrbot_multi_round.py`
- Extend: `tests/astrbot_sdk_flow.py`
- Create: `tests/multimodal_contract.test.mjs`
- Modify: `README.md` only if public fields/configuration changed

- [ ] **Step 1: Add fake-upstream endpoint tests**

Test non-stream and stream OpenAI responses with mixed image/PDF/text inputs, two parallel client tools, tool results, search sources, reasoning, and file output. Assert conversation IDs and context leaf updates are stable across at least two rounds.

- [ ] **Step 2: Run local contract tests**

```bash
node tests/multimodal_contract.test.mjs
```

Expected: PASS without real Sakana credentials by using a fake upstream response stream.

- [ ] **Step 3: Run AstrBot tool-loop scripts when a server is available**

```bash
python tests/astrbot_sdk_flow.py
python tests/astrbot_multi_round.py
```

Expected: tool calls have stable IDs/indexes, JSON arguments parse, usage arrives once, and final text includes tool results. If no live server or credentials are available, report these scripts as skipped rather than treating unit tests as equivalent.

- [ ] **Step 4: Run the full project suite**

```bash
npm test
node tests/context.test.mjs
node tests/request-normalizer.test.mjs
node tests/context-policy.test.mjs
node tests/tool-state.test.mjs
node tests/events.test.mjs
node tests/adapter-contract.test.mjs
node tests/multimodal_contract.test.mjs
```

Expected: all offline tests pass.

- [ ] **Step 5: Inspect the final diff and commit documentation corrections**

```bash
git diff --check
git status --short
git diff --stat
```

Only stage intended source/tests/docs. Never stage runtime cookies, token files, account pools, browser profiles, or API keys.

```bash
git add lib tests README.md
git commit -m "test: verify unified multimodal and tool pipeline"
```
