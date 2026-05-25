# Backend Development Guide

This document describes the Nitro backend for Agentaz.

## Scope

The backend runs the Pi SDK server-side and exposes browser-facing HTTP APIs plus a WebSocket event stream. The current implementation is local-first and single-user by default:

- one startup-configured working directory
- server-resident loaded sessions
- no authentication
- local bind by default
- dangerous tool approvals routed to the browser

The product has moved beyond the original MVP planning phase. Treat this guide as documentation of the current backend shape, not as a permanent constraint on future server-side multi-session/runtime work.

## Main Files

```txt
apps/web/server/api/health.get.ts
apps/web/server/api/agent/
apps/web/server/routes/api/agent/ws.ts
apps/web/server/utils/pi-session-registry.ts
apps/web/server/utils/ws-agent-hub.ts
apps/web/server/utils/extension-ui-context.ts
apps/web/server/utils/permission-config.ts
apps/web/types/protocol.ts
```

## Runtime Configuration

Nuxt runtime config currently defines:

```ts
runtimeConfig: {
  piWeb: {
    cwd: process.env.PI_WEB_CWD || process.cwd(),
    approvalTimeoutMs: Number(process.env.PI_WEB_APPROVAL_TIMEOUT_MS || 5 * 60 * 1000),
    maxLoadedSessions: Number(process.env.PI_WEB_MAX_LOADED_SESSIONS || 5),
    allowNonLocalhost: process.env.HOST && !['127.0.0.1', 'localhost'].includes(process.env.HOST),
  },
}
```

Important constraints:

- `cwd` is startup-configured.
- `maxLoadedSessions` limits the in-memory working set. Loaded sessions stay resident across focus
  changes; when the cap is reached, the registry evicts one idle, non-active session before loading
  another available session.
- The web UI does not currently switch cwd.
- Non-localhost bind should warn because there is no auth.

## HTTP Agent API

Browser-initiated actions and snapshots use HTTP:

```txt
GET    /api/agent/state
GET    /api/agent/models
POST   /api/agent/sessions
POST   /api/agent/sessions/:sessionId/focus
DELETE /api/agent/sessions/:sessionId
GET    /api/agent/sessions/:sessionId/history
GET    /api/agent/sessions/:sessionId/models
PUT    /api/agent/sessions/:sessionId/model
PUT    /api/agent/sessions/:sessionId/thinking
POST   /api/agent/sessions/:sessionId/messages
POST   /api/agent/sessions/:sessionId/abort
POST   /api/agent/sessions/:sessionId/queue/clear
POST   /api/agent/sessions/:sessionId/ui-requests/:requestId/response
```

Route files should stay thin. Put session/runtime behavior in `PiSessionRegistry`, not the route layer.

## WebSocket Endpoint

Endpoint:

```txt
/api/agent/ws
```

Responsibilities:

- Read Nuxt runtime config during `open`.
- Configure the process-wide WebSocket hub.
- Forward lifecycle events to `WsAgentHub`.
- Emit realtime server events to connected browser subscribers.

The route should stay thin. Put connection/session logic in utilities, not the route file.

## WebSocket Hub

`WsAgentHub` owns browser connection lifecycle:

- client attach/detach
- heartbeat snapshots
- rejecting legacy WebSocket command messages
- leaving loaded session lifecycle to `PiSessionRegistry` when browsers disconnect

The hub is currently a process singleton. Configuration is separated from lookup:

```ts
setWsAgentHubConfig(options);
getWsAgentHub();
```

The first config wins. Reconfiguration with different values should fail loudly.

## PiSessionRegistry

`PiSessionRegistry` owns server-resident Pi SDK session lifecycle and browser-facing state:

- create/open/list the loaded working set and available persisted sessions for the current cwd
- return state and WebSocket hello/snapshots without creating a Pi session
- return global model picker defaults without creating a Pi session
- normalize Pi messages/events into `ServerEvent`
- accept prompt/steer/follow-up over HTTP and stream output over WebSocket
- abort and clear queue
- return/set model and thinking state over HTTP
- bind extension UI context
- dispose loaded sessions explicitly

The registry creates Pi SDK services once for the configured `cwd` and reuses those services across
loaded sessions. This avoids reloading SDK extensions, skills, prompts, themes, and context files on
every new session.

For the performance investigation and measured SDK costs behind this choice, see
`docs/session-performance.md`.

Keep Pi SDK details out of the frontend and route handlers.

## Protocol

Protocol types live in:

```txt
apps/web/types/protocol.ts
```

Rules:

- Add protocol changes explicitly.
- Keep WebSocket server events discriminated by `type`.
- Keep HTTP request/response DTOs in the same protocol file.
- Keep frontend message rendering on normalized `UiMessage` / `UiBlock`, not raw Pi SDK internals.
- If adding/changing events, update frontend handling and smoke tests as needed.

Current important server events include:

- `hello`
- `sessions_snapshot`
- `active_session_changed`
- `session_control_changed`
- `message_upsert`
- `message_block_upsert`
- `message_block_delta`
- `permission_decision`
- `queue_update`
- extension UI request/notify events
- `status`
- `error`

## Permissions

Dangerous tool approvals use `@gotgenes/pi-permission-system`.

`permission-config.ts` creates project-level config at:

```txt
<cwd>/.pi/extensions/pi-permission-system/config.json
```

`WebExtensionUIContext` bridges extension UI prompts to the browser by emitting protocol events and waiting for browser responses.

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
- keep loaded sessions server-resident across focus changes and WebSocket disconnects
- evict one idle, non-active session only when `maxLoadedSessions` is reached
- no fork/tree UI

When closing a running loaded session, callers must explicitly pass `abortCurrent`.

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

Smoke script:

```bash
pnpm test:api
pnpm smoke:backend
```

The smoke test assumes the dev server is already running. It checks:

- health endpoint
- REST state/history/models/session lifecycle endpoints
- lightweight control, queue clear, and abort endpoints
- WebSocket `hello` and `sessions_snapshot`
- that REST-only payloads such as history/model list are not emitted over WebSocket

## Verification

After backend code changes, run:

```bash
pnpm typecheck
```

For WebSocket/protocol changes, also consider:

```bash
# terminal 1
pnpm dev

# terminal 2
pnpm smoke:backend
```

Run `pnpm build` only when requested or when changing build/runtime packaging.
