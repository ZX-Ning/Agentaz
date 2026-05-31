# Backend Development Guide

This document describes the Nitro backend for Agentaz.

## Scope

The backend runs the Pi SDK server-side and exposes browser-facing HTTP APIs plus an SSE event stream. The current implementation is local-first and single-user by default:

- one startup-configured working directory
- server-resident loaded sessions
- single-user admin-password authentication
- local bind by default
- dangerous tool approvals routed to the browser

The product has moved beyond the original MVP planning phase. Treat this guide as documentation of the current backend shape, not as a permanent constraint on future server-side multi-session/runtime work.

## Main Files

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

Nuxt runtime config currently defines:

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

- `cwd` is startup-configured.
- `maxLoadedSessions` limits the in-memory working set. Loaded sessions stay resident across focus
  changes; when the cap is reached, the workspace evicts one idle, non-active session before loading
  another available session.
- The web UI does not currently switch cwd.
- `AGENTAZ_ADMIN_PASSWORD_HASH` is required and must be
  `base64(SHA3-256(password-string))`.
- `NUXT_SESSION_PASSWORD` is required separately and must be at least 32
  characters. Do not derive it from the admin password hash.
- Non-localhost bind still warns because the app exposes a powerful single-user
  coding agent surface.

## Authentication

Agentaz uses `nuxt-auth-utils` for encrypted cookie sessions and custom password
verification for the single admin user.

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
`AGENTAZ_ADMIN_PASSWORD_HASH` and calls `setUserSession()` with the admin user
payload on success. Sessions expire after 24 hours.

## HTTP Agent API

Browser-initiated actions and snapshots use HTTP:

```txt
GET    /api/agent/state
GET    /api/agent/models
POST   /api/agent/sessions
POST   /api/agent/sessions/:sessionId/focus
GET    /api/agent/sessions/:sessionId/entries
GET    /api/agent/sessions/:sessionId/history
GET    /api/agent/sessions/:sessionId/models
PUT    /api/agent/sessions/:sessionId/model
PUT    /api/agent/sessions/:sessionId/thinking
POST   /api/agent/sessions/:sessionId/messages
POST   /api/agent/sessions/:sessionId/fork
POST   /api/agent/sessions/:sessionId/revert
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

Uses h3's built-in `createEventStream` to send `text/event-stream` formatted data.

Responsibilities:

- Resolve the configured `AgentRuntime`.
- Adapt the per-request h3 `EventStream` to the `SseAgentHub` writer interface.
- Emit realtime server events to connected browser subscribers.

The route should stay thin. Put connection/session logic in utilities, not the route file.

## SSE Hub

`SseAgentHub` owns browser connection lifecycle:

- client attach/detach
- heartbeat snapshots
- leaving loaded session lifecycle to `PiSessionWorkspace` when browsers disconnect

The hub is owned by the process-wide `AgentRuntime`. Configuration is centralized there:

```ts
configureAgentRuntime(options); // startup plugin
getAgentRuntime().hub; // routes/helpers
```

The first config wins. Reconfiguration with different values should fail loudly.

## Agent Runtime Services

`AgentRuntime` is the process-wide composition root. It owns:

- `PiSessionWorkspace`: Pi SDK services and loaded session lifecycle.
- `ClientPresence`: browser client ids, focus, and control leases.
- `SessionProjector`: client-specific HTTP/SSE state snapshots.
- `AgentEventBus`: typed in-process pub/sub between session runtime and realtime transport.
- `SseAgentHub`: SSE stream lifecycle and event forwarding.

SSE `hello` assigns the browser tab `clientId`. Client-specific HTTP requests should send that
identity back through `X-Agentaz-Client-Id`; routes fall back to `LOCAL_CLIENT_ID` only for non-browser
or pre-SSE callers.

`PiSessionWorkspace` owns server-resident Pi SDK session lifecycle:

- create/open/list the loaded working set and available persisted sessions for the current cwd
- return global model picker defaults without creating a Pi session
- normalize Pi messages/events into `ServerEvent`
- accept prompt/steer/follow-up over HTTP and stream output over SSE
- abort and clear queue
- return/set model and thinking state over HTTP
- bind extension UI context
- dispose loaded sessions explicitly

`PiSessionController` owns browser-facing operations for one loaded Pi session.
It projects one browser-facing assistant `UiMessage` per agent turn, including
consecutive Pi SDK assistant messages and tool result blocks, so live streaming
and HTTP history reload use the same grouping.

The workspace creates Pi SDK services once for the configured `cwd` and reuses those services across
loaded sessions. This avoids reloading SDK extensions, skills, prompts, themes, and context files on
every new session.

For the performance investigation and measured SDK costs behind this choice, see
`docs/implementation/session-performance.md`.

Keep Pi SDK details out of the frontend and route handlers.

## Protocol

Protocol types live in:

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
- `message_upsert`
- `message_block_upsert`
- `message_block_delta`
- `permission_decision`
- `queue_update`
- extension UI request/notify events
- extension widget update events
- `status`
- `error`

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

The running server must be started with matching `AGENTAZ_ADMIN_PASSWORD_HASH`
and `NUXT_SESSION_PASSWORD` values.

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
