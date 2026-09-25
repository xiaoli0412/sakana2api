# Issue #1: Long-Running Memory Growth Design

## Goal

Prevent repeated Playwright auto-session failures from accumulating browser
resources and eventually taking down the host with OOM, while keeping the
existing account-pool behavior and session format compatible.

## Root Cause

`lib/auto-session.js` stores one persistent browser context globally, but its
current recovery path can launch a new persistent context when the old context
has no pages. The old context is not explicitly closed before replacement.
Browser target crashes can therefore leave Chromium resources and stale page
handles behind while the harvest retry loop continues. The process also has no
default V8 heap ceiling or container memory boundary, so a leak can consume
host swap and trigger global OOM.

## Design

### Browser lifecycle

- Add a single-flight browser startup promise so concurrent callers share one
  `launchPersistentContext` operation.
- Reuse a live persistent context regardless of the current page count. Create
  a page only when a caller needs one.
- Track context ownership and clear the global reference when Playwright emits
  `close` or `disconnected`.
- Centralize recovery for target/context crash errors. Close the failed context,
  clear all references, wait with bounded exponential backoff, and retry only a
  finite number of times.
- Make `stop()` cancel timers, wait for queued browser work, and close the
  current context. Repeated stop calls remain harmless.

The account pool continues to serialize harvest and refresh calls through the
existing auto-session lock. No account identity or cookie merge behavior is
changed by this work.

### Observability

- Extend `/health` with process uptime and RSS/heap metrics while retaining
  `ok: true` for existing healthchecks.
- Include auto-session browser state (context present, page count, recovery
  count, last error/recovery timestamp) in the existing stats operations data.
- Keep metrics bounded and scalar; do not expose cookies, tokens, or mailbox
  contents.

### Container guardrails

- Set a default `NODE_OPTIONS=--max-old-space-size=1536` in the image entrypoint,
  preserving an explicitly supplied `NODE_OPTIONS` value.
- Add configurable Compose memory and swap limits with a 2 GiB default total
  boundary, while retaining `restart: unless-stopped`.
- Keep the limits overrideable through environment variables for hosts with
  different capacity.

## Error Handling

- A crashed target is recoverable: close and discard the context, back off, and
  retry within the configured limit.
- A normal login or upstream error is not treated as a browser crash and keeps
  the existing account-pool retry behavior.
- If recovery attempts are exhausted, propagate the original operation error so
  the caller can apply the existing harvest backoff rather than spinning.
- Cleanup errors are swallowed after being recorded in bounded diagnostics;
  shutdown must not hang on a broken browser process.

## Testing

Add deterministic unit tests around the exported auto-session lifecycle hooks:

1. Concurrent browser acquisition launches one context.
2. A context close/disconnect clears the cached reference and permits exactly
   one replacement.
3. A crash recovery closes the failed context and applies bounded retry delay.
4. `stop()` closes the context and is idempotent.

Extend endpoint/config tests to verify health memory fields and default
container guardrails without requiring a real browser or network login. Run
the existing unit suite and the new focused tests.

## Non-Goals

- Rewriting account-pool scheduling or changing account identity semantics.
- Persisting memory metrics to disk or introducing an external monitoring
  service.
- Increasing the account pool beyond the configured minimum/maximum.
- Changing the upstream Sakana protocol.
