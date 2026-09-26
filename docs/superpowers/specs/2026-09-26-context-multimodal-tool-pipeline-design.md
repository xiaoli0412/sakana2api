# Context, Multimodal, Tool, Reasoning, and Search Pipeline Design

## Goal

Improve the proxy's context continuity, multimodal input/output, client tool calls,
reasoning visibility, and built-in search while preserving OpenAI/AstrBot
compatibility as the first priority and keeping Gemini/Anthropic endpoints
compatible.

## Scope and Priority

The work uses a shared internal event model and is delivered in three stages:

1. Normalize requests and add mixed context validation.
2. Normalize upstream events and stabilize tools, reasoning, search, and files.
3. Upgrade Gemini and Anthropic adapters from the same event model and complete
   multimodal compatibility tests.

The existing Sakana upstream protocol, account pool, and server-side execution
boundary remain in place. Sakana sandbox tools are never exposed as client
 tools.

## Request and Context Architecture

Add a request normalization layer before the existing Sakana request builder.
OpenAI Chat/Responses, Gemini contents, and Anthropic Messages are normalized to
one internal message shape preserving role, order, text parts, attachments,
tool calls, and tool results.

Attachments use a common shape:

```text
{id, name, mime, source, bytes, sha256, order}
```

The normalizer accepts data URLs, base64, remote URLs, and Buffers. Remote
fetches enforce a timeout and byte limit, then MIME sniffing fills missing or
untrusted types. Download or validation failures return explicit diagnostic
errors instead of silently dropping the attachment. Mixed text and attachments
retain their original order.

Large text is chunked at file/message boundaries with filename and chunk-order
markers. The proxy no longer reduces all long context to only the first and
last 1500 characters. Visual and document prompts identify attachment numbers
and filenames so multiple files cannot be confused.

Context entries retain:

```text
conversationId, accountId, lastMessageId,
firstMessageFingerprint, recentClientHistoryFingerprint,
recentUserFingerprint, updatedAt
```

Context selection uses this priority:

1. Explicit `conversation_id`, `chat_id`, or `thread_id`.
2. Server-side first-message fingerprint.
3. Client history fingerprint validation.

When client history contains known server history, continue the server
conversation without resending the full history. A different first message,
tool-call identity, or forked user turn creates a new conversation. An invalid
explicit ID is cleared and rebuilt only once, preventing migration loops. After
every completed turn, including transparent native-tool continuation, update
`lastMessageId` and history fingerprints. Streaming failures still save the
last recoverable conversation position.

## Internal Event Model

Sakana NDJSON is converted to internal events before any protocol adapter:

```text
content_delta
reasoning_delta
reasoning_status
 tool_call_start
tool_call_delta
tool_call_end
tool_result
search_started
search_source
file_output
status
finish
usage
```

Each event has a stable turn id and optional tool/file/source metadata. The
OpenAI, Gemini, and Anthropic adapters consume the same event sequence instead
of independently interpreting Sakana updates.

## Tool State Machine

Tool calls are indexed by both upstream `tool_call_id` and upstream index.
Names and IDs are emitted once; argument fragments append to the same indexed
call; parallel calls preserve their original indexes. The state machine emits:

- OpenAI `delta.tool_calls[]` fragments with stable `index`, `id`, `type`, and
  function name/arguments.
- Anthropic `tool_use` content blocks with matching input JSON fragments.
- Gemini `functionCall` parts with stable call names and arguments.

Client-declared tools are returned to the client. Sakana built-in sandbox tools
remain server-side and continue transparently until text or a client tool call
is produced. Tool results retain `tool_call_id`, name, content, and error state
internally; the Sakana request builder creates the upstream-compatible prompt
without losing structured identity.

Native continuation has one bounded state machine. Every continuation refreshes
the upstream conversation leaf and context entry. The loop ends on text, a
client tool call, an explicit status error, or the configured maximum rounds.

## Reasoning and Search

Reasoning events carry `reasoning_kind` values `model`, `search`, or `status`.
`<thinking>` tags and Sakana `reasoning` updates are normalized at the event
layer. Safety-stop text is removed once at that layer.

Search emits both visible reasoning status and structured source events. Sources
are deduplicated by title and URL and preserve snippets/content when available.
OpenAI receives `reasoning_content` plus `citations` and optional structured
`search_results`; Gemini receives thought parts plus grounding metadata; Anthropic
receives compatible thinking/text blocks and metadata without breaking the
Messages schema.

Thinking/search mutual exclusion with upstream remains unchanged: search mode
turns upstream thinking off, and search progress is surfaced as structured
reasoning status.

## Multimodal Output

Input supports images, PDF/documents, text files, audio, data URLs, base64, and
remote URLs through the common attachment normalizer. MIME, byte size, order,
and remote fetch behavior are tested independently.

Upstream `file` events become `file_output` events carrying `name`, `sha`, `mime`,
size when known, and a downloadable URL when the conversation id is available.
OpenAI non-stream responses include a `files` array; streaming responses emit
file metadata without breaking normal content chunks. Gemini and Anthropic
adapters preserve convertible file metadata.

Long documents are uploaded in ordered chunks with explicit filename/chunk
markers. Image/document prompts reference attachment order and filenames rather
than treating binary data as plain text.

## Usage, Errors, and Compatibility

Usage is emitted once after finish. OpenAI keeps the existing
`choices: []` include-usage tail chunk. Existing fields including
`reasoning_content`, `tool_calls`, and `citations` remain available; new
structured fields are additive.

Attachment validation, remote download, and context-fork failures use explicit
error codes and concise messages. Ordinary text requests preserve current model
selection and thinking/search mutual exclusion.

## Testing and Delivery

Stage 1 adds normalizer, context fingerprint/fork, attachment limit, and
conversation-leaf tests. Stage 2 adds event and tool-state tests for fragmented,
parallel, native, and client tool calls, plus reasoning/search/file output.
Stage 3 adds OpenAI/AstrBot, Gemini, and Anthropic adapter contract tests and
multimodal endpoint tests using a fake upstream stream. Existing unit tests and
AstrBot multi-round scripts remain required.

## Non-Goals

- Executing arbitrary client tools inside the proxy.
- Exposing Sakana sandbox commands to API clients.
- Changing account-pool scheduling or authentication.
- Replacing the upstream Sakana protocol.
- Adding an external database or queue in this optimization cycle.
