# Pi Web Agent Product Plan

## 1. Goal

Build a personal, local-first/server-hosted agent application powered by the Pi SDK, with a browser UI as one interaction surface.

The app is not a multi-user SaaS or team platform. It has moved beyond the original MVP boundary; this document records confirmed product decisions and the current implementation baseline.

## 2. Confirmed Decisions And Baseline

### Product Model

- Target: **personal local/server-hosted Pi agent with a Web UI**.
- Local-first remains the default trust model.
- Access is protected by single-user admin-password auth using an encrypted
  `nuxt-auth-utils` session cookie.
- The agent runs on the Nuxt/Nitro server side.
- The browser UI talks to the server over HTTP APIs plus an SSE event stream.
- Multi-user auth, accounts, team concepts, and SaaS behavior are not confirmed goals.

### Authentication

- Authentication is single-user and admin-panel style, not account based.
- `NUXT_SESSION_PASSWORD` is required and must be at least 32 characters. It is
  used only by `nuxt-auth-utils` to encrypt/sign the session cookie.
- `AGENTAZ_ADMIN_PASSWORD_HASH` is required and must contain
  `base64(SHA3-256(password-string))`.
- The login endpoint hashes the exact UTF-8 password string entered in the
  browser and compares it with `AGENTAZ_ADMIN_PASSWORD_HASH`.
- Sessions last 24 hours.
- All existing app API endpoints are protected, including `GET /api/health` and
  `GET /api/agent/events`. The only public API endpoints are login and the
  `nuxt-auth-utils` session discovery endpoint required by the frontend.

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
apps/web/server/api/agent/events.get.ts   SSE streaming endpoint
apps/web/server/utils/agent-runtime.ts
apps/web/server/utils/pi-session-workspace.ts
apps/web/server/utils/client-presence.ts
apps/web/server/utils/session-projector.ts
apps/web/server/utils/agent-event-bus.ts
apps/web/server/utils/sse-agent-hub.ts
apps/web/server/utils/extension-ui-context.ts
apps/web/server/utils/permission-config.ts
```

### Transport

- Use **HTTP** for browser-initiated actions and snapshot queries.
- Use **SSE (Server-Sent Events)** over HTTP streaming for server-initiated realtime events.
- Full session history is fetched over HTTP, not pushed as an SSE event.
- Model/thinking state is queried and changed over HTTP, not pushed through dedicated SSE model events.

Current HTTP endpoints:

```txt
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/_auth/session
GET    /api/health
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
POST   /api/agent/sessions/:sessionId/abort
POST   /api/agent/sessions/:sessionId/queue/clear
POST   /api/agent/sessions/:sessionId/ui-requests/:requestId/response
GET    /api/agent/events
```

### Session Behavior

- The server owns a small loaded Pi session working set in a process-wide `PiSessionWorkspace`.
- Loaded sessions stay resident across focus changes and SSE detach until the working set reaches `maxLoadedSessions`.
- When the loaded-session cap is reached, the workspace evicts one idle, non-active session before opening another persisted session.
- Pi SDK services/resources are initialized once per configured `cwd` and reused across loaded sessions.
- The backend does not create an initial loaded session for `GET /api/agent/state` or SSE attach.
- The frontend represents startup/New session as a local draft and creates the real Pi session on the first user prompt.
- Draft sessions fetch global model options without creating a Pi session and apply the selected model/thinking settings when materialized.
- Users can create new sessions and open available persisted sessions for the configured `cwd`.
- Session list scope is current `cwd`, using Pi `SessionManager.list(cwd)`.
- Real sessions use `/session/:sessionId` browser routes. Draft sessions stay at `/`, and the frontend moves to the real session route after the first prompt materializes the draft.
- Focusing a session changes the active browser view and then the frontend fetches history over HTTP.
- Loaded-session eviction is an internal cache policy; the UI does not expose loaded/unloaded state as a user action.
- Simple loaded-session fork/revert backend APIs operate on the current branch only.
- Full Pi tree navigation, clone workflows, labels, and branch-summary UI are not implemented.

### Browser Client Model

- This is still a single-user app.
- SSE clients are realtime subscribers, not multi-user principals; they
  must still present a valid single-user auth session cookie before connecting.
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
- `permission-config.ts` creates global permission config under the Pi agent directory:

```txt
<agentDir>/extensions/pi-permission-system/config.json
```

- Browser-backed extension UI prompts are emitted over SSE:
  - `ui_select_request`
  - `ui_input_request`
  - `ui_confirm_request`
- Browser-backed extension text widgets are emitted over SSE:
  - `extension_widget_update`
- Browser responses are submitted over HTTP:

```txt
POST /api/agent/sessions/:sessionId/ui-requests/:requestId/response
```

The response body uses an explicit discriminator:

```ts
{ kind: "select", selected?: string }
{ kind: "input", value?: string }
{ kind: "confirm", confirmed: boolean }
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
  ├─ SSE event subscriber
  ├─ Session/sidebar state
  ├─ Transcript state
  ├─ Model/thinking controls
  └─ Approval response UI

Nuxt/Nitro Server
  ├─ HTTP agent routes
  ├─ SSE route /api/agent/events
  ├─ AgentRuntime
  ├─ PiSessionWorkspace
  ├─ ClientPresence
  ├─ SessionProjector
  ├─ AgentEventBus
  ├─ SseAgentHub
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

### SSE Events

SSE is server-to-client for realtime events. Browser commands should not be sent over SSE.

Current important events:

- `hello`
- `state_snapshot`
- `control_changed`
- `message_upsert`
- `message_block_upsert`
- `message_block_delta` for streaming `text`, `thinking`, and `tool_result` blocks
- `permission_decision`
- `queue_update`
- `ui_select_request`
- `ui_input_request`
- `ui_confirm_request`
- `ui_notify`
- `extension_widget_update`
- `status`
- `error`

REST-only data must not be emitted as SSE result events:

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
- SSE server event stream
- process-wide server-resident working session workspace
- new/open/focus sessions, with capped server-resident loaded session retention
- persisted session listing for current `cwd`
- history loading over HTTP
- prompt/steer/follow-up over HTTP with streaming output over SSE
- assistant text/thinking deltas
- tool lifecycle events, including streaming bash tool output as `tool_result` deltas
- stop and clear queue
- model list and current-session model selection
- thinking level selection
- `@gotgenes/pi-permission-system` integration
- generated Pi agent-dir permission config if missing
- browser-backed approval requests and HTTP approval responses
- structured smoke test for REST and SSE protocol boundaries
- simple user-message anchored fork/revert UI for loaded persisted sessions

### Excluded

- multi-user auth
- API key management UI
- cwd switching in Web UI
- clone/tree navigation
- file browser
- image upload UI
- diff viewer
- debug event panel
- mobile-first design
- writing model choices to Pi settings

## 6. Future Directions

These are not committed product scope. Move an item into the baseline sections
above when it becomes an accepted implementation decision.

### Near-Term UX

- Improve assistant streaming, tool rendering, collapsed thinking blocks, and
  transcript auto-scroll behavior.
- Make approval prompts more informative, including timeout state and richer
  approve-once / approve-session / deny affordances where the backend supports them.
- Improve session list scanning, active session indication, manual refresh, and
  confirmation around switching while work is running.
- Expand fork/revert from simple user-message anchors into richer branch
  navigation once full Pi tree semantics are productized.

### Product Expansion

- Multi-tab semantics: multiple viewers, explicit controller takeover, shared
  transcript state, and per-client connection status.
- Project/cwd switching: recent projects, project selector, runtime
  reinitialization, and per-project permission configuration.
- Pi tree workflows beyond simple current-branch fork/revert: clone, full tree
  navigation, labels, and branch summaries.
- File and diff views: file tree, read-only previews, edit/write diffs, tool
  result previews, and safe apply/revert affordances.
- UI-only persistence such as sidebar state, recent prompts, and per-project
  display settings. Avoid adding a database until there is a concrete need.

### Hardening And Packaging

- Stronger frontend handling for unknown events and protocol-version mismatch.
- More detailed backend smoke tests and optional structured local logs.
- Security review before broader network exposure: CSRF/origin checks,
  SSE exposure, filesystem/tool-access assumptions, and permission defaults.
- Packaging options such as a local CLI wrapper, desktop wrapper,
  single-command project launcher, and improved environment checks.
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
