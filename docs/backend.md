# Backend Development Guide

This document describes the Nitro backend for Agentaz.

## Scope

The backend runs the Pi SDK server-side and exposes a browser-facing WebSocket protocol. The MVP is intentionally local-first and single-user:

- one startup-configured working directory
- one active browser client at a time
- no authentication
- local bind by default
- dangerous tool approvals routed to the browser

## Main Files

```txt
apps/web/server/api/health.get.ts
apps/web/server/routes/api/agent/ws.ts
apps/web/server/utils/ws-agent-hub.ts
apps/web/server/utils/pi-agent-service.ts
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
    allowNonLocalhost: process.env.HOST && !['127.0.0.1', 'localhost'].includes(process.env.HOST),
  },
}
```

Important constraints:

- `cwd` is startup-configured.
- The web UI should not switch cwd in MVP.
- Non-localhost bind should warn because there is no auth.

## WebSocket Endpoint

Endpoint:

```txt
/api/agent/ws
```

Responsibilities:

- Parse `?force=1` takeover flag.
- Read Nuxt runtime config during `open`.
- Configure the process-wide WebSocket hub.
- Forward lifecycle events to `WsAgentHub`.

The route should stay thin. Put connection/session logic in utilities, not the route file.

## WebSocket Hub

`WsAgentHub` owns browser connection lifecycle:

- one active browser peer
- reject additional clients unless `?force=1`
- force takeover cleanup
- heartbeat ping/pong
- forwarding browser commands to `PiAgentService`
- disposing service state on close/error
- cancelling pending approvals when needed

The hub is intentionally a process singleton for the MVP. Configuration is separated from lookup:

```ts
setWsAgentHubConfig(options)
getWsAgentHub()
```

The first config wins. Reconfiguration with different values should fail loudly.

## PiAgentService

`PiAgentService` owns Pi SDK lifecycle and browser protocol handling:

- initialize new Pi sessions
- open/list persisted sessions for the current cwd
- normalize Pi messages/events into `ServerEvent`
- handle prompt/steer/follow-up commands
- abort and clear queue
- list/set model
- set thinking level
- bind extension UI context
- dispose current session cleanly

Keep Pi SDK details out of the frontend and route handlers.

## Protocol

Protocol types live in:

```txt
apps/web/types/protocol.ts
```

Rules:

- Add protocol changes explicitly.
- Keep browser commands and server events discriminated by `type`.
- Keep frontend message rendering on normalized `UiMessage` / `UiBlock`, not raw Pi SDK internals.
- If adding/changing events, update frontend handling and smoke tests as needed.

Current important server events include:

- `hello`
- `history`
- `message_delta`
- `message_upsert`
- `tool_start`
- `tool_update`
- `tool_end`
- `model_list_result`
- `session_list_result`
- `status`
- `error`
- extension UI request/notify events

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

MVP behavior:

- start with a new session by default
- list sessions for current cwd
- open/resume selected session
- no background multi-session execution
- no fork/tree UI

When switching sessions while running, frontend should confirm. Backend should abort/dispose before switching when requested.

## Error Handling

Backend should emit unified protocol errors:

```ts
{ type: 'error', code, message, recoverable }
```

Also log unexpected server-side errors to console for local development.

## Health and Smoke Tests

HTTP health endpoint:

```txt
GET /api/health
```

Smoke script:

```bash
pnpm smoke:backend
```

The smoke test assumes the dev server is already running and checks basic health/WS handshake behavior.

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
