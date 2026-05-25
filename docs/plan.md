# Pi Web Agent Product Plan

## 1. Goal

Build a personal, local-first/server-hosted agent application powered by the Pi SDK, with a browser UI as one interaction surface.

The app is not a multi-user SaaS or team platform. It has moved beyond the original MVP boundary; this document records confirmed product decisions and the current implementation baseline.

## 2. Confirmed Decisions And Baseline

### Product Model

- Target: **personal local/server-hosted Pi agent with a Web UI**.
- Local-first remains the default trust model.
- The agent runs on the Nuxt/Nitro server side.
- The browser UI talks to the server over HTTP APIs plus a WebSocket event stream.
- Multi-user auth, accounts, team concepts, and SaaS behavior are not confirmed goals.

### Working Directory

- The agent operates on a startup-specified `cwd`.
- The Web UI does not currently choose or switch project directories.
- Future cwd switching may require rebuilding Pi runtime resources, not just changing a field in UI state.

### Process And Repository Shape

- Use a pnpm workspace with one Nuxt fullstack app under `apps/web`.
- Keep Pi SDK integration server-side only.
- Keep browser/server protocol types in `apps/web/types/protocol.ts`.
- Keep backend runtime utilities under `apps/web/server/utils/`.

Important backend pieces:

```txt
apps/web/server/api/agent/                HTTP agent API routes
apps/web/server/routes/api/agent/ws.ts    WebSocket event route
apps/web/server/utils/agent-runtime.ts
apps/web/server/utils/pi-session-workspace.ts
apps/web/server/utils/client-presence.ts
apps/web/server/utils/session-projector.ts
apps/web/server/utils/agent-event-bus.ts
apps/web/server/utils/ws-agent-hub.ts
apps/web/server/utils/extension-ui-context.ts
apps/web/server/utils/permission-config.ts
```

### Transport

- Use **HTTP** for browser-initiated actions and snapshot queries.
- Use **WebSocket** for server-initiated realtime events only.
- Full session history is fetched over HTTP, not pushed as a WebSocket event.
- Model/thinking state is queried and changed over HTTP, not pushed through dedicated WS model events.

Current HTTP endpoints:

```txt
GET    /api/health
GET    /api/agent/state
GET    /api/agent/models
POST   /api/agent/sessions
POST   /api/agent/sessions/:sessionId/focus
GET    /api/agent/sessions/:sessionId/history
GET    /api/agent/sessions/:sessionId/models
PUT    /api/agent/sessions/:sessionId/model
PUT    /api/agent/sessions/:sessionId/thinking
POST   /api/agent/sessions/:sessionId/messages
POST   /api/agent/sessions/:sessionId/abort
POST   /api/agent/sessions/:sessionId/queue/clear
POST   /api/agent/sessions/:sessionId/ui-requests/:requestId/response
WS     /api/agent/ws
```

### Session Behavior

- The server owns a small loaded Pi session working set in a process-wide `PiSessionWorkspace`.
- Loaded sessions stay resident across focus changes and WebSocket detach until the working set reaches `maxLoadedSessions`.
- When the loaded-session cap is reached, the workspace evicts one idle, non-active session before opening another persisted session.
- Pi SDK services/resources are initialized once per configured `cwd` and reused across loaded sessions.
- The backend does not create an initial loaded session for `GET /api/agent/state` or WebSocket attach.
- The frontend represents startup/New session as a local draft and creates the real Pi session on the first user prompt.
- Draft sessions fetch global model options without creating a Pi session and apply the selected model/thinking settings when materialized.
- Users can create new sessions and open available persisted sessions for the configured `cwd`.
- Session list scope is current `cwd`, using Pi `SessionManager.list(cwd)`.
- Focusing a session changes the active browser view and then the frontend fetches history over HTTP.
- Loaded-session eviction is an internal cache policy; the UI does not expose loaded/unloaded state as a user action.
- Fork/tree/clone workflows are not implemented.

### Browser Client Model

- This is still a single-user app.
- WebSocket clients are realtime subscribers, not authentication principals.
- Browser-initiated mutations use HTTP APIs.
- Runtime control leases are acquired automatically around mutating operations and surface as conflict errors, not as a manual browser action.

### Model And Thinking Settings

- Available models come from Pi `ModelRegistry`.
- Model changes use `session.setModel(model)`.
- Thinking changes use `session.setThinkingLevel(level)`.
- If a session is streaming or has queued messages, model/thinking changes are queued and applied when the session becomes idle.
- Model/thinking choices affect only the current loaded session. They are not written to Pi settings.

### Permission Approval UX

- Dangerous tool approvals use `@gotgenes/pi-permission-system`.
- `permission-config.ts` creates project-level config under:

```txt
<cwd>/.pi/extensions/pi-permission-system/config.json
```

- Browser-backed extension UI prompts are emitted over WebSocket:
  - `ui_select_request`
  - `ui_input_request`
  - `ui_confirm_request`
- Browser-backed extension text widgets are emitted over WebSocket:
  - `extension_widget_update`
- Browser responses are submitted over HTTP:

```txt
POST /api/agent/sessions/:sessionId/ui-requests/:requestId/response
```

- Approval timeout defaults to cancellation/deny, never allow.
- Stop/abort cancels pending browser-backed approval prompts.

### UI Baseline

Current frontend is a protocol-testing UI, not the final UX:

- sidebar with open, working, and available sessions
- active transcript
- model/thinking controls
- prompt composer
- basic pending approval panel
- light/dark mode

The frontend should keep state normalized around `UiMessage` and `UiBlock`, not raw Pi SDK objects.

## 3. Architecture

```txt
Browser / Nuxt Frontend
  ├─ HTTP client for actions and snapshots
  ├─ WebSocket event subscriber
  ├─ Session/sidebar state
  ├─ Transcript state
  ├─ Model/thinking controls
  └─ Approval response UI

Nuxt/Nitro Server
  ├─ HTTP agent routes
  ├─ WebSocket route /api/agent/ws
  ├─ AgentRuntime
  ├─ PiSessionWorkspace
  ├─ ClientPresence
  ├─ SessionProjector
  ├─ AgentEventBus
  ├─ WsAgentHub
  ├─ WebExtensionUIContext
  ├─ Permission config generator
  └─ Protocol/event normalization

Pi SDK
  ├─ createAgentSession
  ├─ SessionManager
  ├─ AuthStorage / ModelRegistry
  ├─ Extensions
  │   ├─ @gotgenes/pi-permission-system
  │   └─ @juicesharp/rpiv-todo
  ├─ Tools
  └─ Agent events
```

## 4. Protocol

Protocol types live in:

```txt
apps/web/types/protocol.ts
```

### HTTP DTOs

HTTP APIs return request/response DTOs declared in `protocol.ts`, including:

- `AgentStateResponse`
- `SessionHistoryResponse`
- `SessionOperationResponse`
- `ModelStateResponse`
- `MessageSubmitRequest`
- `MessageSubmitResponse`
- `UiRequestResponseRequest`

HTTP errors should use a structured payload:

```ts
{ code: string, message: string, recoverable: boolean }
```

### WebSocket Events

WebSocket is server-to-client for realtime events. Browser commands should not be sent over WS.

Current important events:

- `hello`
- `state_snapshot`
- `control_changed`
- `message_upsert`
- `message_block_upsert`
- `message_block_delta`
- `permission_decision`
- `queue_update`
- `ui_select_request`
- `ui_input_request`
- `ui_confirm_request`
- `ui_notify`
- `extension_widget_update`
- `status`
- `error`

REST-only data must not be emitted as WS result events:

- full `history`
- session list result
- model list result
- model/thinking changed result

## 5. Current Baseline Scope

### Included

- Nuxt fullstack app
- startup-specified `cwd`
- server-side Pi SDK integration
- HTTP agent API for actions and snapshots
- WebSocket server event stream
- process-wide server-resident working session workspace
- new/open/focus sessions, with capped server-resident loaded session retention
- persisted session listing for current `cwd`
- history loading over HTTP
- prompt/steer/follow-up over HTTP with streaming output over WS
- assistant text/thinking deltas
- tool lifecycle events
- stop and clear queue
- model list and current-session model selection
- thinking level selection
- `@gotgenes/pi-permission-system` integration
- generated project-level permission config if missing
- browser-backed approval requests and HTTP approval responses
- structured smoke test for REST and WS protocol boundaries

### Excluded

- multi-user auth
- API key management UI
- cwd switching in Web UI
- fork/clone/tree navigation
- file browser
- image upload UI
- diff viewer
- debug event panel
- mobile-first design
- writing model choices to Pi settings

## 6. Open Product Directions

- Multi-tab UX:
  - multiple viewers
  - explicit controller semantics
  - shared transcript state
- Pi tree workflows:
  - fork
  - clone
  - navigate tree
  - labels and branch summaries
- CWD switching/project selector.
- Diff viewer for edit/write results.
- Image upload/paste support.
- File explorer/project browser.
- Debug panel for raw Pi/WS events.
- Permission settings UI.
- Persist model/thinking defaults with an explicit "set as default" action.
- Authentication/token mode for non-localhost deployments.

## 7. Verification

After normal code edits:

```bash
pnpm typecheck
```

For protocol/backend changes, with a dev server already running:

```bash
pnpm test:api
```
