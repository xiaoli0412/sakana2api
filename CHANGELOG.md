# v0.21.2

## Blocked datacenter IPs (egress proxy)

- New `SAKANA_UPSTREAM_PROXY`: Node→upstream requests go through an undici `ProxyAgent`, read at call time so it can change without a restart. Use the same egress as `SAKANA_BROWSER_PROXY` so `cf_clearance` stays bound to one IP.
- New `SAKANA_BROWSER_HEADLESS=1`: forces headless launches for servers without X/Xvfb. Previously the persistent context tried headful first, failed, and delayed startup before falling back to isolated harvest.
- Verified on a Cloudflare-blocked datacenter IP: direct requests return 403; with mihomo on `127.0.0.1:7992` and both env vars, the browser registered 3 accounts and real chat returned 200.

## Live stress harness

- New `npm run test:stress:live` (`scripts/stress_remote.mjs`): growing full-history turns, 20k-char prompt, 24 KB Markdown attachment, 512×512 image, SSE stream, delta continuation, bounded concurrency burst, per-call latency/tokens plus the server audit tail.
- Measured on the deployed server: 8-concurrency 20/20 requests, p50 5.0 s / p95 8.2 s; 12-concurrency 24/24, p50 6.0 s / p95 10.1 s; 20k text 8–11 s, 24 KB file 5–6 s, image ~4 s; zero errors, zero queue timeouts.

## Verification

- `npm test`: 44 node tests + 1 deployment-runtime test, all green (45 steps).
- Live: 3 pooled accounts, peak 8–12 in-flight, `leaseCount` returns to 0, no upstream 403 after the proxy switch.

---

# v0.21.1

## Registration reliability (2026-11 upstream login change)

- The sign-in dialog now offers **Continue with Google** and **Continue with Apple** above the email form. The automation matched all three Continue buttons and died in Playwright strict mode; the email path now matches the dialog's Continue exactly.
- Turnstile gate detection no longer mistakes the sign-in modal's backdrop for the bootstrap challenge. The dialog's invisible widget no longer costs ~48 s per attempt.
- Navigation retries once after a cold-start abort; the Cloudflare shield exits early on blank documents instead of waiting the full 120 s.
- Measured live: fresh registration **158 s → 24 s**, full registration-to-chat flow 35 s.

## Account import (P1)

- `POST /api/accounts/import` accepts raw Cookie headers, Cookie-Editor / EditThisCookie JSON, Playwright storageState, `cookies.txt`, and structured arrays. CRLF header injection is rejected and non-`sakana.ai` cookies are dropped.
- Import probes `/api/v2/user/settings` before a cookie can enter the pool. Failures return a structured `reason` (`invalid_session` / `turnstile_challenge` / `rate_limited` / `upstream_error` / `network_error`) and never occupy a pool slot.
- Optional `/api/rate-limit/status` quota snapshot in `validation`; `GET /api/accounts` exposes per-account validations plus lease pressure. Repeated systemic probe failures trigger a bounded backoff (`429 PROBE-BACKOFF`), tunable via `SAKANA_IMPORT_PROBE_*`.
- Admin panel: paste box with format detection, validation badges, per-account validation column, and lease statistics.

## Maintainability (P2-P4)

- `server.js` 2452 → 1941 lines: extracted `lib/admin-routes.js`, `lib/http-auth.js`, `lib/public-routes.js`, `lib/http-util.js`.
- `translate.js` 1220 → 746 lines: extracted `lib/model-profiles.js`, `lib/ndjson-translator.js`, `lib/text-utils.js`; all public re-exports are unchanged.
- Test groups: `npm run test:core` / `test:http` / `test:native` / `test:deploy`; `npm test` keeps its original sequential command.
- Wiki: deployment guide, API reference, session isolation, account-pool operations; dead links removed.

## Verification

- `npm test`: 44 node tests + 1 deployment-runtime test, all green (45 steps).
- `npm run test:live`: 7/7 — fresh registration, 9-model list, non-stream chat, SSE stream, admin import, pool projection without cookie leakage.

---

# v0.21.0

## Conversation isolation and reliability

- Full-history requests are authoritative and stateless by default. The proxy no longer derives a shared conversation from the first user message.
- Stateful continuation requires `history_mode: "delta"` and an explicitly supplied `conversation_id`, `chat_id`, `thread_id`, or matching header. Missing, expired, foreign, or model-mismatched state returns a stable 4xx error instead of silently rebuilding from the last turn.
- Context records are scoped by credential and, when supplied, `x-client-session-id`. The built-in UI creates a random browser-local scope and sends it on business requests, so copied conversation IDs and copied browser scope values cannot cross API-key boundaries.
- Generation and final cursor commits are serialized per owned conversation. Separate conversations continue to run concurrently.
- OpenAI Chat Completions, Responses, Anthropic Messages, and Gemini adapters now share the same context contract.

## Long context and UI

- Canonical normalized message graphs are used for TXT/JSON packaging, preserving earlier system, user, assistant, tool, and attachment references for fiction and programming workflows.
- Long-context transport instructions are neutral and no longer demand citations, exclusive facts, or internal protocol recitation.
- Optical compression is lazy, serialized, cache-bounded, and falls back to the complete source when page coverage is truncated.
- Added a reachable persistent dark theme with synchronized header/sidebar/chat controls, mobile drawer focus handling, keyboard support, and responsive composer layout.
- Usage reporting continues to expose estimated input, output, total tokens, elapsed time, and generation speed.

## Security and operations

- Client-controlled remote attachments and mailbox-provider requests validate every DNS destination, block private/special IPv4 and IPv6 ranges, pin approved lookups, bound redirects and response sizes, and strip credentials after origin changes.
- Persisted-admin deployments no longer fail open when business keys are empty or revoked.
- Conversation list/read/stop access is scoped; foreign or unknown conversations are rejected before upstream access.
- Character-card metadata inflation, state-file symlink loops, upstream branch selection, and optical renderer failure paths are bounded and covered by regressions.
- Deployment archives are built from tracked files plus an explicit allowlist, reject tracked secrets/state, preserve executable modes and LF text, and fail closed on durable-state conflicts without deleting either copy.

## Verification

- Full `npm test` release gate passes, including the 100-request stress test, 43-case HTTP isolation suite, UI theme matrix, security regressions, and offline deployment migration tests.
- Research references used for the session contract: [Sub2API](https://github.com/Wei-Shaw/sub2api), [grok2api](https://github.com/chenyme/grok2api), [Kimi-Free-API](https://github.com/xiaoY233/Kimi-Free-API), and [OpenAI conversation state guidance](https://developers.openai.com/api/docs/guides/conversation-state).
