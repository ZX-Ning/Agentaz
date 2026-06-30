# Backend Development Guide

This document describes the Agentaz backend during the Deno/Hono migration.

The migration target is a Deno workspace with a Hono backend package under
`packages/api`. The legacy Nuxt/Nitro backend under `apps/web/server` remains as
the current runnable compatibility baseline until the frontend and smoke tests
are switched over.

## Scope

The backend runs the Pi SDK server-side and exposes browser-facing HTTP APIs plus an SSE event stream. The current implementation is local-first and single-user by default:

- one startup-configured working directory
- server-resident loaded sessions
- single-user admin-password authentication
- local bind by default
- dangerous tool approvals routed to the browser

The product has moved beyond the original MVP planning phase. Treat this guide
as documentation of the current backend shape and migration target, not as a
permanent constraint on future server-side multi-session/runtime work.

## Main Files

New Deno/Hono package:

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

Legacy Nuxt/Nitro backend, kept during migration:

```txt
apps/web/server/api/health.get.ts
apps/web/server/api/agent/
apps/web/server/api/agent/events.get.ts
apps/web/server/utils/agent-runtime.ts
apps/web/server/utils/pi-session-workspace.ts
apps/web/server/utils/client-presence.ts
apps/web/server/utils/session-projector.ts
apps/web/server/utils/agent-event-bus.ts
apps/web/server/utils/sse-agent-hub.ts
apps/web/server/utils/extension-ui-context.ts
apps/web/server/utils/permission-config.ts
apps/web/types/protocol.ts
```

## Runtime Configuration

The Deno/Hono backend reads runtime configuration from environment variables at
process startup:

```txt
PI_WEB_CWD                       working directory, defaults to Deno.cwd()
PI_WEB_APPROVAL_TIMEOUT_MS       defaults to 300000
PI_WEB_MAX_LOADED_SESSIONS       defaults to 5
AGENTAZ_ADMIN_PASSWORD_HASH      required base64(SHA3-256(password-string))
AGENTAZ_SESSION_SECRET           optional stable HMAC cookie secret, 32+ chars
NUXT_SESSION_PASSWORD            legacy fallback secret accepted during migration
HOST / DENO_HOST                 used only for non-localhost exposure warnings
```

Shared runtime constraints:

- `cwd` is startup-configured.
- `maxLoadedSessions` limits the in-memory working set. Loaded sessions stay resident across focus
  changes; when the cap is reached, the workspace evicts one idle, non-active session before loading
  another available session.
- The web UI does not currently switch cwd.
- Non-localhost bind still warns because the app exposes a powerful single-user
  coding agent surface.

The legacy Nuxt runtime config currently defines:

```ts
runtimeConfig: {
  session: {
    maxAge: 60 * 60 * 24,
  },
  piWeb: {
    /**
     * Build-time defaults only. The startup plugin
     * (server/plugins/startup.ts) reads PI_WEB_CWD,
     * PI_WEB_APPROVAL_TIMEOUT_MS, and
     * PI_WEB_MAX_LOADED_SESSIONS at runtime and
     * overrides these values.
     */
    cwd: "",
    approvalTimeoutMs: 5 * 60 * 1000,
    maxLoadedSessions: 5,
  },
}
```

**Why not `process.env.PI_WEB_CWD` in nuxt.config.ts?**

Nuxt evaluates `process.env` expressions at build time and bakes
the resulting value into the build output. Setting `PI_WEB_CWD` at
runtime would have no effect if the value were read in
`nuxt.config.ts`. The startup plugin is server-only code that runs at
process start, so it reads the runtime environment correctly.

Important constraints:

- `AGENTAZ_ADMIN_PASSWORD_HASH` is required and must be
  `base64(SHA3-256(password-string))`.
- `NUXT_SESSION_PASSWORD` is optional but recommended for stable sessions across
  restarts. When provided, it must be at least 32 characters. When omitted, the
  startup plugin generates a process-local secret and writes it into runtime
  config before auth routes are used. Do not derive it from the admin password
  hash.
- Non-localhost bind still warns because the app exposes a powerful single-user
  coding agent surface.

## Authentication

The Deno/Hono backend currently uses stateless signed cookie sessions and custom
password verification for the single admin user. Password compatibility with
`nuxt-auth-utils` is not required. The cookie secret is `AGENTAZ_SESSION_SECRET`
when provided, or `NUXT_SESSION_PASSWORD` as a migration fallback. If neither is
provided, startup generates a process-local secret and existing browser sessions
are invalid after restart. Auth.js can be introduced later, but it is not wired
in the current Hono package.

The legacy Nuxt backend uses `nuxt-auth-utils` for encrypted cookie sessions.

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

The login route compares `base64(SHA3-256(password))` with
`AGENTAZ_ADMIN_PASSWORD_HASH` and creates a 24-hour admin session on success.

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
formatted data. The legacy Nuxt backend uses h3's `createEventStream`.

Responsibilities:

- Resolve the configured `AgentRuntime`.
- Adapt the per-request transport stream to the `SseAgentHub` writer interface.
- Emit realtime server events to connected browser subscribers.

The route should stay thin. Put connection/session logic in utilities, not the route file.

## SSE Hub

`SseAgentHub` owns browser connection lifecycle:

- client attach/detach
- heartbeat snapshots
- leaving loaded session lifecycle to `PiSessionWorkspace` when browsers disconnect

The hub is owned by the process-wide `AgentRuntime`. Configuration is centralized there:

```ts
configureAgentRuntime(options); // Deno startup or legacy Nitro plugin
getAgentRuntime().hub; // routes/helpers
```

The first config wins. Reconfiguration with different values should fail loudly.

## Agent Runtime Services

`AgentRuntime` is the process-wide composition root. It owns:

- `PiSessionWorkspace`: Pi SDK services and loaded session lifecycle.
- `ClientPresence`: browser client ids, focus, and control leases.
- `AgentEventBus`: typed in-process pub/sub between session runtime and realtime transport.
- `SseAgentHub`: SSE stream lifecycle and event forwarding.

Client-specific HTTP/SSE state snapshots are built by pure helpers in
`session-projector.ts`, not by an AgentRuntime-owned service.

SSE `hello` assigns the browser tab `clientId`. Client-specific HTTP requests should send that
identity back through `X-Agentaz-Client-Id`; routes fall back to `LOCAL_CLIENT_ID` only for non-browser
or pre-SSE callers.

`PiSessionWorkspace` owns server-resident Pi SDK session lifecycle:

- create/open/list the loaded working set and available persisted sessions for the current cwd
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

The workspace shares only process-wide backing objects that are not extension runtimes
(`AuthStorage`, `ModelRegistry`, working directory). Each loaded `PiSessionController` owns its own
Pi SDK `AgentSessionServices` instance with a controller-local resource loader and extension runtime.
This per-controller isolation prevents stale extension context errors when one loaded session is
disposed while another session's extensions are still active (e.g. permission-system pollers).

Service creation is still warmed at the workspace level for required Pi package configuration,
but full SDK extension loading happens per controller. See
`docs/implementation/session-performance.md` for the performance tradeoff and investigation
history.

Keep Pi SDK details out of the frontend and route handlers.

Manual context compact uses `POST /api/agent/sessions/:sessionId/compact`.
The browser should pass the active loaded session id explicitly. The operation
is synchronous and intentionally idle-only: if the session is initializing,
streaming, has queued messages, has pending browser UI prompts, or is already
compacting, the backend returns `409 session_busy` instead of aborting current
work. A session that is too small to compact, or already compacted at the
current leaf, returns `409 context_compact_unavailable`.

## Protocol

Protocol types live in:

```txt
packages/protocol/mod.ts
```

While the Nuxt frontend remains, keep the legacy mirror in sync:

```txt
apps/web/types/protocol.ts
```

Rules:

- Add protocol changes explicitly.
- Keep SSE server events discriminated by `type`.
- Keep HTTP request/response DTOs in the same protocol file.
- Keep frontend message rendering on normalized `UiMessage` / `UiBlock`, not raw Pi SDK internals.
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

The `status` SSE event and loaded-session state (`UiRuntimeLoadedSession`) include optional Pi SDK usage fields:

- `contextUsage` (`UiContextUsage | undefined`): current context window usage from `session.getContextUsage()`. Includes `tokens` (nullable), `contextWindow`, and `percent` (nullable). Nullable when the session has not yet sent an LLM request (e.g. right after compaction or before the first prompt).
- `usageStats` (`UiSessionUsageStats | undefined`): cumulative stats for the current persisted branch. Includes message/tool counts, token breakdown (`input`, `output`, `cacheRead`, `cacheWrite`, `total`), and `cost`. Calculated from session entries so totals do not reset after context compact. Nullable only if usage projection fails.

These fields are refreshed on every `sendStatus()` call (after turns, compaction, model changes, queue updates, and reconnect recovery). Do not estimate tokens in Agentaz — use Pi SDK as the single source of truth.

History projection includes Pi `compaction` entries as durable `system`
messages in the transcript. The marker is intentionally concise and uses the
persisted `tokensBefore` value; the full compaction summary remains in the Pi
session entry and is not rendered in the chat transcript by default.

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

`permission-config.ts` creates global permission config under the Pi agent directory:

```txt
<agentDir>/extensions/pi-permission-system/config.json
```

`agentDir` comes from `PI_CODING_AGENT_DIR` or the Pi SDK default.

`WebExtensionUIContext` bridges extension UI prompts to the browser by emitting protocol events and waiting for browser responses. It also renders extension widgets as plain text lines for browser display, currently used by `@juicesharp/rpiv-todo`.

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
- create a real Pi session only when the frontend opens a persisted session or materializes a draft
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

Smoke script:

```bash
pnpm test:api
pnpm smoke:backend
```

The smoke test assumes the dev server is already running. It checks:

- unauthenticated HTTP and SSE rejection
- login with `PI_WEB_SMOKE_ADMIN_PASSWORD`
- authenticated health endpoint
- authenticated REST state/history/models/session lifecycle endpoints

The running server must be started with an `AGENTAZ_ADMIN_PASSWORD_HASH` value
matching `PI_WEB_SMOKE_ADMIN_PASSWORD`. If `NUXT_SESSION_PASSWORD` is omitted,
the server generates a process-local session secret and smoke-test login still
works for that process.

## Verification

After backend code changes, run:

```bash
pnpm typecheck
```

For SSE/protocol changes, also consider:

```bash
# terminal 1
pnpm dev

# terminal 2
pnpm smoke:backend
```

Run `pnpm build` only when requested or when changing build/runtime packaging.
