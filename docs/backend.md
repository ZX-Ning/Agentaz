# Backend Development Guide

This document describes the Agentaz backend in the Deno workspace. The Hono API
package lives under `packages/api` and serves the browser-facing HTTP APIs, SSE
event stream, and optional built frontend assets.

## Scope

The backend runs the Pi SDK server-side and exposes browser-facing HTTP APIs
plus an SSE event stream. The current implementation is local-first and
single-user by default:

- one startup-configured working directory
- server-resident loaded sessions
- single-user admin-password authentication
- local bind by default
- dangerous tool approvals routed to the browser

The product has moved beyond the original MVP planning phase. Treat this guide
as documentation of the current backend shape, not as a permanent constraint on
future server-side multi-session/runtime work.

## Main Files

Deno/Hono package:

```txt
packages/api/deno.json
packages/api/src/main.ts
packages/api/src/routes/health.ts
packages/api/src/routes/auth.ts
packages/api/src/routes/agent.ts
packages/api/src/auth/auth.ts
packages/api/src/http/agent.ts
packages/api/src/http/errors.ts
packages/api/src/runtime/agent-runtime.ts
packages/api/src/runtime/client-presence.ts
packages/api/src/runtime/event-bus.ts
packages/api/src/runtime/session-projector.ts
packages/api/src/runtime/sse-hub.ts
packages/api/src/pi/session-workspace.ts
packages/api/src/pi/session-controller.ts
packages/api/src/extensions/ui-context.ts
packages/api/src/extensions/permission-config.ts
packages/api/src/errors.ts
packages/protocol/mod.ts
```

## Runtime Configuration

The Deno/Hono backend reads runtime configuration from environment variables at
process startup:

```txt
PI_WEB_CWD                       working directory, defaults to Deno.cwd()
PI_WEB_APPROVAL_TIMEOUT_MS       defaults to 300000
PI_WEB_MAX_LOADED_SESSIONS       defaults to 5
AGENTAZ_ADMIN_PASSWORD_HASH      required base64(SHA3-256(password-string))
AGENTAZ_SESSION_SECRET           optional stable Better Auth secret, 32+ chars
AGENTAZ_PI_NODE_MODULES_DIR       optional preinstalled Pi extension node_modules root
STATIC_FILE_DIR                  optional built SPA directory served by Hono
```

Shared runtime constraints:

- `cwd` is startup-configured.
- `maxLoadedSessions` limits the in-memory working set. Loaded sessions stay
  resident across focus changes; when the cap is reached, the workspace evicts
  one idle, non-active session before loading another available session.
- `AGENTAZ_PI_NODE_MODULES_DIR`, when set, points at a `node_modules` directory
  containing the required Pi extension packages. Agentaz writes those local
  package roots into Pi settings when present and falls back to the `npm:`
  package sources when absent.
- The web UI does not currently switch cwd.
- `STATIC_FILE_DIR`, when set, serves static frontend assets and falls back to
  `index.html` for browser document routes outside `/api`.
- The checked-in `deno task serve` binds to `127.0.0.1:3000`. Broader network
  exposure should be explicit and reviewed because the app exposes a powerful
  single-user coding agent surface.

Important constraints:

- `AGENTAZ_ADMIN_PASSWORD_HASH` is required and must be
  `base64(SHA3-256(password-string))`.
- `AGENTAZ_SESSION_SECRET` is optional but recommended for stable sessions
  across restarts. When provided, it must be at least 32 characters. When
  omitted, startup generates a process-local secret before auth routes are used.
  Do not derive it from the admin password hash.

## Authentication

The Deno/Hono backend uses Better Auth crypto for the single admin user's
encrypted stateless cookie session. It does not enable Better Auth's
database-backed users/accounts model. Do not add an auth adapter or database
unless the product model changes.

Better Auth uses `AGENTAZ_SESSION_SECRET` when provided. If it is omitted,
startup generates a process-local secret and existing browser sessions are
invalid after restart.

Public auth endpoints:

```txt
POST   /api/auth/login
GET    /api/_auth/session
```

Protected auth endpoint:

```txt
POST   /api/auth/logout
```

All other `/api/**` endpoints are protected by server middleware, including
`GET /api/health`. The SSE endpoint `GET /api/agent/events` also requires a
valid session cookie before the event stream is opened.

The login route remains a project JSON endpoint. It compares
`base64(SHA3-256(password))` with `AGENTAZ_ADMIN_PASSWORD_HASH`, then stores a
24-hour encrypted stateless admin session in an HTTP-only cookie on success.

## HTTP Agent API

Browser-initiated actions and snapshots use HTTP:

```txt
GET    /api/agent/state
GET    /api/agent/models
POST   /api/agent/sessions
PATCH  /api/agent/sessions/metadata
POST   /api/agent/sessions/delete
POST   /api/agent/sessions/:sessionId/focus
GET    /api/agent/sessions/:sessionId/entries
GET    /api/agent/sessions/:sessionId/history
GET    /api/agent/sessions/:sessionId/models
PUT    /api/agent/sessions/:sessionId/model
PUT    /api/agent/sessions/:sessionId/thinking
POST   /api/agent/sessions/:sessionId/messages
POST   /api/agent/sessions/:sessionId/fork
POST   /api/agent/sessions/:sessionId/revert
POST   /api/agent/sessions/:sessionId/compact
POST   /api/agent/sessions/:sessionId/abort
POST   /api/agent/sessions/:sessionId/queue/clear
POST   /api/agent/sessions/:sessionId/ui-requests/:requestId/response
```

Route files should stay thin. Put session/runtime behavior in the runtime
services, not the route layer. Agent routes should resolve the process runtime
through `getAgentRuntime()` or route helpers that wrap it, then delegate to the
workspace, presence, and projector services.

## SSE Endpoint

Endpoint:

```txt
GET /api/agent/events
```

The Deno/Hono backend uses Hono streaming helpers to send `text/event-stream`
formatted data.

Responsibilities:

- Resolve the configured `AgentRuntime`.
- Adapt the per-request transport stream to the `SseAgentHub` writer interface.
- Emit realtime server events to connected browser subscribers.

The route should stay thin. Put connection/session logic in utilities, not the
route file.

## SSE Hub

`SseAgentHub` owns browser connection lifecycle:

- client attach/detach
- heartbeat snapshots
- leaving loaded session lifecycle to `PiSessionWorkspace` when browsers
  disconnect

The hub is owned by the process-wide `AgentRuntime`. Configuration is
centralized there:

```ts
configureAgentRuntime(options); // Deno startup
getAgentRuntime().hub; // routes/helpers
```

The first config wins. Reconfiguration with different values should fail loudly.

## Agent Runtime Services

`AgentRuntime` is the process-wide composition root. It owns:

- `PiSessionWorkspace`: Pi SDK services and loaded session lifecycle.
- `ClientPresence`: browser client ids, focus, and control leases.
- `AgentEventBus`: typed in-process pub/sub between session runtime and realtime
  transport.
- `SseAgentHub`: SSE stream lifecycle and event forwarding.

Client-specific HTTP/SSE state snapshots are built by pure helpers in
`session-projector.ts`, not by an AgentRuntime-owned service.

SSE `hello` assigns the browser tab `clientId`. Client-specific HTTP requests
should send that identity back through `X-Agentaz-Client-Id`; routes fall back
to `LOCAL_CLIENT_ID` only for non-browser or pre-SSE callers.

`PiSessionWorkspace` owns server-resident Pi SDK session lifecycle:

- create/open/list the loaded working set and available persisted sessions for
  the current cwd
- return global model picker defaults without creating a Pi session
- normalize Pi messages/events into `ServerEvent`
- accept prompt/steer/follow-up over HTTP and stream output over SSE
- compact an idle loaded session's active context over HTTP
- abort and clear queue
- return/set model and thinking state over HTTP
- bind extension UI context
- dispose loaded sessions explicitly

`PiSessionController` owns browser-facing operations for one loaded Pi session.
It projects one browser-facing assistant `UiMessage` per agent turn, including
consecutive Pi SDK assistant messages and tool result blocks, so live streaming
and HTTP history reload use the same grouping.

The workspace shares only process-wide backing objects that are not extension
runtimes (`AuthStorage`, `ModelRegistry`, working directory). Each loaded
`PiSessionController` owns its own Pi SDK `AgentSessionServices` instance with a
controller-local resource loader and extension runtime. This per-controller
isolation prevents stale extension context errors when one loaded session is
disposed while another session's extensions are still active (e.g.
permission-system pollers).

Service creation is still warmed at the workspace level for required Pi package
configuration, but full SDK extension loading happens per controller. See
`docs/implementation/session-performance.md` for the performance tradeoff and
investigation history.

Keep Pi SDK details out of the frontend and route handlers.

Manual context compact uses `POST /api/agent/sessions/:sessionId/compact`. The
browser should pass the active loaded session id explicitly. The operation is
synchronous and intentionally idle-only: if the session is initializing,
streaming, has queued messages, has pending browser UI prompts, or is already
compacting, the backend returns `409 session_busy` instead of aborting current
work. A session that is too small to compact, or already compacted at the
current leaf, returns `409 context_compact_unavailable`.

## Protocol

Protocol types live in:

```txt
packages/protocol/mod.ts
```

Rules:

- Add protocol changes explicitly.
- Keep SSE server events discriminated by `type`.
- Keep HTTP request/response DTOs in the same protocol file.
- Keep frontend message rendering on normalized `UiMessage` / `UiBlock`, not raw
  Pi SDK internals.
- If adding/changing events, update frontend handling and smoke tests as needed.

Current important server events include:

- `hello`
- `state_snapshot`
- `control_changed`
- `turn_started`
- `turn_completed`
- `turn_failed`
- `message_upsert`
- `message_block_upsert`
- `message_block_delta`
- `permission_decision`
- `queue_update`
- extension UI request/notify events
- extension widget update events
- `status`
- `error`

`turn_started` confirms the browser's optimistic user message with a canonical
backend `UiMessage` keyed by `clientMessageId`. `turn_completed` is the normal
signal that HTTP history is stable enough to refresh, and carries the
`transcriptRevision` that the frontend uses to ignore stale history responses.
`turn_failed` carries the prompt correlation fields when available so the
frontend can discard local placeholders and re-read authoritative history.
`status` and `state_snapshot` must not be used as implicit transcript-refresh
signals; they are for runtime state, control, pending UI, and reconnect
recovery.

### Usage Data

The `status` SSE event and loaded-session state (`UiRuntimeLoadedSession`)
include optional Pi SDK usage fields:

- `contextUsage` (`UiContextUsage | undefined`): current context window usage
  from `session.getContextUsage()`. Includes `tokens` (nullable),
  `contextWindow`, and `percent` (nullable). Nullable when the session has not
  yet sent an LLM request (e.g. right after compaction or before the first
  prompt).
- `usageStats` (`UiSessionUsageStats | undefined`): cumulative stats for the
  current persisted branch. Includes message/tool counts, token breakdown
  (`input`, `output`, `cacheRead`, `cacheWrite`, `total`), and `cost`.
  Calculated from session entries so totals do not reset after context compact.
  Nullable only if usage projection fails.

These fields are refreshed on every `sendStatus()` call (after turns,
compaction, model changes, queue updates, and reconnect recovery). Do not
estimate tokens in Agentaz — use Pi SDK as the single source of truth.

History projection includes Pi `compaction` entries as durable `system` messages
in the transcript. The marker is intentionally concise and uses the persisted
`tokensBefore` value; the full compaction summary remains in the Pi session
entry and is not rendered in the chat transcript by default.

`clientMessageId` belongs to prompt submissions only. `follow_up` currently
queues text inside Pi's pending queue and does not create a confirmed browser
transcript turn; adding visible queued user messages requires a separate
queued-message protocol instead of reusing `turn_started`.

`message_block_delta` can stream `text`, `thinking`, and `tool_result` blocks.
Pi SDK bash updates provide accumulated `partialResult.content`; the backend
computes the incremental delta before emitting it to the browser. When Pi SDK
emits multiple assistant messages inside one agent turn, the backend keeps them
in one browser-facing assistant `UiMessage` and starts fresh text/thinking
blocks at each assistant `message_start` so tool blocks stay in temporal order.
History normalization should mirror the same one-assistant-message-per-turn
projection when reloading sessions over HTTP.

## Permissions

Dangerous tool approvals use `@gotgenes/pi-permission-system`.

`permission-config.ts` creates global permission config under the Pi agent
directory:

```txt
<agentDir>/extensions/pi-permission-system/config.json
```

`agentDir` comes from `PI_CODING_AGENT_DIR` or the Pi SDK default.

`WebExtensionUIContext` bridges extension UI prompts to the browser by emitting
protocol events and waiting for browser responses. It also renders extension
widgets as plain text lines for browser display, currently used by
`@juicesharp/rpiv-todo`.

Expected approval behavior:

- approve once
- approve for session
- deny
- deny with reason where supported
- timeout defaults to deny/cancel
- disconnect cancels pending approvals immediately

Do not remove the permission-system integration without updating `docs/plan.md`.

## Session Behavior

Current behavior:

- start with no loaded session unless one already exists in the process
- create a real Pi session only when the frontend opens a persisted session or
  materializes a draft
- list sessions for current cwd
- open/resume selected session
- keep loaded sessions server-resident across focus changes and SSE disconnects
- evict one idle, non-active session only when `maxLoadedSessions` is reached
- do not expose loaded-session close/unload as a user-facing browser action
- expose simple loaded-session fork/revert HTTP APIs for the current branch only
- do not expose full Pi tree navigation in the browser UI

## Error Handling

Backend should emit unified protocol errors:

```ts
{
    type: ("error", code, message, recoverable);
}
```

Also log unexpected server-side errors to console for local development.

## Health and Smoke Tests

HTTP health endpoint:

```txt
GET /api/health
```

This endpoint requires authentication.

Backend smoke coverage lives in Deno tests:

```bash
deno task test
```

The smoke test starts an in-process Hono server. It checks:

- unauthenticated HTTP and SSE rejection
- login with the test admin password
- authenticated health endpoint
- logout behavior
- SPA static fallback when `STATIC_FILE_DIR` is set

The test sets `AGENTAZ_ADMIN_PASSWORD_HASH` and `AGENTAZ_SESSION_SECRET`
directly, so it does not require a separately running dev server.

## Verification

After backend code changes, run:

```bash
deno task check
deno task test
```

Run `deno task build:web-ui` only when requested or when changing frontend
build/runtime packaging.
