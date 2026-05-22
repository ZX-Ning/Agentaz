# Pi Web Agent MVP Plan

## 1. Goal

Build a personal, local-first Web UI for a Pi-based AI coding agent.

The product is initially a browser-accessible version of Pi for one local user. It should let the user run Pi against a chosen project directory, stream assistant output, inspect tool execution, approve dangerous operations from the browser, manage sessions, and switch model/thinking settings.

This is **not** initially a multi-user SaaS or team platform.

## 2. Confirmed Decisions

### Primary use case

- Target: **personal local Web Pi**.
- Not initially multi-user.
- Not initially SaaS.

### Working directory

- The agent operates on a **startup-specified `cwd`**.
- The Web UI does not choose or switch project directories in MVP.
- Future cwd switching may require `createAgentSessionRuntime()` because cwd-bound resources need rebuilding.

### Framework and process model

- Use **Nuxt**.
- Use **Nuxt fullstack single process** for MVP.
- Pi SDK runs on the Nuxt/Nitro server side.
- Frontend and backend communicate via WebSocket.

### Repository structure

Use a pnpm workspace with one app:

```txt
Agentaz/
  pnpm-workspace.yaml
  apps/
    web/
      nuxt.config.ts
      server/
      app/
```

Pi server utilities should live under:

```txt
apps/web/server/utils/
```

Examples:

```txt
apps/web/server/utils/pi-agent-service.ts
apps/web/server/utils/ws-agent-hub.ts
apps/web/server/utils/permission-config.ts
apps/web/server/utils/extension-ui-context.ts
```

### Transport

- Use **WebSocket**.
- One WebSocket endpoint carries all agent commands and backend events.
- HTTP API is only needed for health checks initially.

Planned endpoints:

```txt
WS   /api/agent/ws
GET  /api/health
```

### WebSocket client policy

- MVP allows **one active browser client**.
- If a second client connects while one is active, reject the new connection.
- Add heartbeat ping/pong to clean up dead connections.
- Allow explicit force takeover as an escape hatch.
- Post-MVP: support multiple tabs, likely multiple viewers plus one controller.

### Security / binding

- MVP has no login/auth.
- Default bind host should be `127.0.0.1`.
- Allow env override, e.g. `HOST=0.0.0.0`, but print a strong warning because the app has no authentication.

### API keys

- Reuse Pi's default credential resolution.
- Use Pi default `AuthStorage` / `ModelRegistry`, including:
  - `~/.pi/agent/auth.json`
  - environment variables
  - existing Pi settings/models
- MVP does not implement API key management UI.

### Model and thinking settings

- MVP supports model selection in Web UI.
- Available models come from `modelRegistry.getAvailable()`.
- Use `session.setModel(model)` to change model.
- MVP supports thinking level selection via `session.setThinkingLevel(level)`.
- If the agent is currently running or has pending queued messages, model/thinking changes are queued and applied only after the current workflow is fully idle.
- Model/thinking choices affect only the current session. They are not written to Pi settings in MVP.

### Session behavior

- MVP supports:
  - new session
  - list sessions for current `cwd`
  - resume/open selected session
- MVP starts with a **new session by default**.
- Historical sessions are restored manually from the session list.
- Session list scope: current `cwd` only, using `SessionManager.list(cwd)`.
- When restoring a session, backend sends normalized history derived from `session.messages`.
- If switching/new session while agent is running, show confirmation; if confirmed, abort current run, dispose old session, then switch.
- MVP does not support true background multi-session execution.
- MVP does not support fork/tree/clone.

### Pi SDK layer

MVP can use `createAgentSession()` plus explicit service-level switching:

- create new session with `SessionManager.create(cwd)`
- open existing session with `SessionManager.open(path)`
- list sessions with `SessionManager.list(cwd)`
- dispose old session on switch
- rebind extensions and event subscriptions after each new/open

Post-MVP may migrate to `createAgentSessionRuntime()` for first-class session replacement, fork, clone, and tree navigation.

### Tools and permission model

- Use full coding tool capability, but dangerous operations require approval.
- Use `@gotgenes/pi-permission-system` as the permission engine.
- Do not build a custom tool-wrapper approval layer for MVP.
- Generate project-level permission config at startup if missing.
- Dangerous defaults:
  - read-like tools: allow
  - `bash`: ask
  - `edit`: ask
  - `write`: ask
  - sensitive paths like `.env`: deny
  - external directory access: ask

Example generated project config:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/gotgenes/pi-permission-system/main/schemas/permissions.schema.json",
  "debugLog": false,
  "permissionReviewLog": true,
  "yoloMode": false,
  "piInfrastructureReadPaths": [],
  "permission": {
    "*": "allow",
    "read": "allow",
    "grep": "allow",
    "find": "allow",
    "ls": "allow",
    "bash": "ask",
    "edit": "ask",
    "write": "ask",
    "path": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    },
    "external_directory": "ask"
  }
}
```

Config path:

```txt
<cwd>/.pi/extensions/pi-permission-system/config.json
```

### Permission approval UX

Use the permission system's full decision model:

- approve once
- approve for session
- deny
- deny with reason

The Web UI should display permission requests from `ctx.ui.select()` and return the selected label to the server-side `ExtensionUIContext`.

When the user clicks Stop while an approval is pending:

- close pending approval dialog
- resolve the waiting UI promise as cancelled/undefined
- permission-system should treat that as not approved
- abort current agent operation

Approval timeout policy:

- WebSocket disconnect cancels all pending approvals immediately.
- Pending approval also times out after a fixed duration, e.g. 5 minutes.
- Timeout defaults to cancellation/deny, never allow.

### Events shown in UI

MVP frontend displays:

- assistant text streaming
- tool lifecycle: start/update/end
- tool arguments and result summary
- permission decision/status events
- queue state
- errors

MVP does not need a raw debug event panel.

### Message model

Backend should normalize Pi messages/events into an app-level model rather than exposing raw Pi internals.

Suggested normalized message shape:

```ts
type UiMessage = {
  id: string
  role: "user" | "assistant" | "tool" | "system"
  blocks: UiBlock[]
  createdAt?: number
}

type UiBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; collapsed?: boolean }
  | { type: "tool_call"; toolCallId: string; toolName: string; input: unknown; status: "pending" | "running" | "completed" | "error" | "blocked" }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean }
```

The frontend should not read session files directly.

### Thinking display

- Display thinking in a collapsed block.
- Default UI should not mix thinking into normal assistant text.

### Queueing behavior

MVP supports both:

- `steer`
- `followUp`

When the agent is streaming, sending a prompt must choose one of these behaviors.

Expose queue state via:

- `queue_update` events
- `session.getSteeringMessages()`
- `session.getFollowUpMessages()`
- `session.pendingMessageCount`

Abort controls:

- Stop: `session.abort()`
- Clear Queue: `session.clearQueue()`

### Images

- Protocol should reserve an `images` field.
- MVP UI does not implement image upload/paste.

### File browser

- MVP does not implement a file tree or file browser.
- Users refer to paths in prompts; Pi tools handle file inspection.

### Diff display

- MVP does not render diffs.
- For `edit/write`, show only tool execution status/summary.
- Post-MVP can add a diff viewer.

### Logs and debugging

- MVP logs to server console.
- No debug panel initially.
- `pi-permission-system` can keep its permission review log.

### Error handling

Use a unified WebSocket error event:

```ts
type ServerErrorEvent = {
  type: "error"
  code: string
  message: string
  recoverable: boolean
}
```

Do not encode system errors as assistant messages, because that pollutes Pi conversation history.

### Responsive UI

- MVP should have basic responsive behavior.
- Desktop browser remains the primary target.

## 3. Architecture

```txt
Browser / Nuxt Frontend
  ├─ Chat UI
  ├─ Tool status UI
  ├─ Approval modal
  ├─ Session list/new/resume controls
  ├─ Model/thinking controls
  └─ WebSocket client + state store

Nuxt/Nitro Server
  ├─ WebSocket route /api/agent/ws
  ├─ PiAgentService
  ├─ WebSocket Agent Hub
  ├─ Web-backed ExtensionUIContext
  ├─ Permission config generator
  ├─ Session switching logic
  └─ Event normalization

Pi SDK
  ├─ createAgentSession
  ├─ SessionManager
  ├─ AuthStorage / ModelRegistry
  ├─ DefaultResourceLoader
  ├─ Extensions
  │   └─ @gotgenes/pi-permission-system
  ├─ Tools
  └─ Agent events
```

## 4. Backend Components

### `PiAgentService`

Responsibilities:

- own current `AgentSession`
- create new session
- open existing session
- list current-cwd sessions
- subscribe/unsubscribe to session events
- bind extension UI context
- expose `prompt`, `steer`, `followUp`, `abort`, `clearQueue`
- expose model/thinking APIs
- normalize history and events
- dispose old session during switch

Important: every time a new session is created/opened, reattach:

- `session.subscribe(...)`
- `session.bindExtensions(...)`
- permission event forwarding if bound through shared event bus/resource loader

### `WsAgentHub`

Responsibilities:

- manage single active WebSocket client
- reject second connection unless force takeover is requested
- heartbeat/ping-pong
- route client commands to `PiAgentService`
- send server events to client
- manage pending UI requests such as approval selects/inputs
- cancel pending approval on disconnect, timeout, or stop

### `ExtensionUIContext` bridge

Implements Pi `ExtensionUIContext` server-side. Important methods:

- `select(title, options)` → send `ui_select_request` over WS, await response
- `input(title, placeholder)` → send `ui_input_request` over WS, await response
- `confirm(title, message)` → send `ui_confirm_request`, await response
- `notify(message, type)` → send `ui_notify`

TUI-specific methods can be no-ops for MVP.

### Permission config generator

At startup:

1. Resolve configured `cwd`.
2. Ensure directory exists:

   ```txt
   <cwd>/.pi/extensions/pi-permission-system/
   ```

3. If `config.json` does not exist, write default MVP config.
4. Do not overwrite an existing config.

## 5. WebSocket Protocol Draft

All messages should include a protocol version at connection/hello time.

### Server hello

```ts
type ServerHello = {
  type: "hello"
  protocolVersion: 1
  cwd: string
  sessionId: string
  sessionFile?: string
  capabilities: {
    steer: true
    followUp: true
    clearQueue: true
    permissions: true
    modelSelect: true
    thinkingSelect: true
    images: false
    fileTree: false
    diffViewer: false
  }
}
```

### Client commands

```ts
type ClientCommand =
  | { type: "prompt"; text: string; images?: ImagePayload[] }
  | { type: "steer"; text: string; images?: ImagePayload[] }
  | { type: "follow_up"; text: string; images?: ImagePayload[] }
  | { type: "abort" }
  | { type: "clear_queue" }
  | { type: "session_new" }
  | { type: "session_list" }
  | { type: "session_open"; sessionFile: string; abortCurrent?: boolean }
  | { type: "model_list" }
  | { type: "model_set"; provider: string; id: string }
  | { type: "thinking_set"; level: ThinkingLevel }
  | { type: "ui_select_response"; requestId: string; selected?: string }
  | { type: "ui_input_response"; requestId: string; value?: string }
  | { type: "ui_confirm_response"; requestId: string; confirmed: boolean }
```

Reserved image payload:

```ts
type ImagePayload = {
  mediaType: "image/png" | "image/jpeg" | "image/webp" | string
  data: string // base64
}
```

### Server events

```ts
type ServerEvent =
  | ServerHello
  | { type: "history"; messages: UiMessage[] }
  | { type: "message_delta"; messageId: string; blockType: "text" | "thinking"; delta: string }
  | { type: "message_upsert"; message: UiMessage }
  | { type: "tool_start"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_update"; toolCallId: string; partial: unknown }
  | { type: "tool_end"; toolCallId: string; isError: boolean; summary?: string }
  | { type: "permission_decision"; surface: string; value: string; result: "allow" | "deny"; resolution: string; matchedPattern?: string | null }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "session_list_result"; sessions: UiSessionSummary[] }
  | { type: "session_changed"; sessionId: string; sessionFile?: string; history: UiMessage[] }
  | { type: "model_list_result"; models: UiModel[]; current?: UiModel }
  | { type: "model_changed"; model: UiModel; pending?: boolean }
  | { type: "thinking_changed"; level: ThinkingLevel; pending?: boolean }
  | { type: "ui_select_request"; requestId: string; title: string; options: string[]; timeoutMs: number }
  | { type: "ui_input_request"; requestId: string; title: string; placeholder?: string; timeoutMs: number }
  | { type: "ui_confirm_request"; requestId: string; title: string; message: string; timeoutMs: number }
  | { type: "ui_notify"; message: string; level?: "info" | "warning" | "error" }
  | { type: "status"; isStreaming: boolean; pendingMessageCount: number }
  | ServerErrorEvent
```

Session summary:

```ts
type UiSessionSummary = {
  file: string
  name?: string
  createdAt?: number
  updatedAt?: number
  firstMessage?: string
}
```

Model summary:

```ts
type UiModel = {
  provider: string
  id: string
  name?: string
}
```

## 6. Frontend State

Use a frontend state store, likely Pinia, because the app needs centralized state for:

- connection status
- current session
- message list
- tool calls
- pending approval dialogs
- queue state
- session list
- model list/current model
- thinking level
- errors/toasts

UI component library and visual design are deferred. The MVP UI only needs to support the required interaction surfaces.

## 7. MVP Scope

### Included

- pnpm workspace with Nuxt app
- Nuxt server-side Pi SDK integration
- startup-specified cwd
- WebSocket `/api/agent/ws`
- one active browser client
- heartbeat and optional force takeover
- new session by default
- session list for current cwd
- open/resume selected session
- normalized history loading
- prompt, steer, followUp
- assistant streaming text
- collapsed thinking display
- tool lifecycle display
- stop and clear queue
- model list and current-session model selection
- thinking level selection
- `@gotgenes/pi-permission-system` integration
- generated project-level permission config if missing
- Web approval bridge with four decisions
- approval cancellation on stop/disconnect/timeout
- server console logging
- unified frontend error event

### Excluded

- multi-user auth
- API key management UI
- cwd switching in Web UI
- true concurrent multi-session runtime
- fork/clone/tree navigation
- file browser
- image upload UI
- diff viewer
- debug event panel
- mobile-first design
- writing model choices to Pi settings

## 8. Post-MVP Roadmap

- True multi-session/runtime support:
  - background sessions
  - event routing per session
  - concurrent runs
  - approval ownership per session/client
- Multi-tab support:
  - multiple viewers
  - one controller
  - takeover/lease model
- Pi tree workflows:
  - fork
  - clone
  - navigate tree
  - labels
  - branch summaries
- CWD switching/project selector.
- Diff viewer for edit/write results.
- Image upload/paste support.
- File explorer/project browser.
- Debug panel for raw Pi/WS events.
- Permission settings UI.
- More advanced permission policies:
  - pattern suggestions
  - per-command risk tiers
  - per-session approval review
- Persist model/thinking defaults with explicit "set as default" action.
- Authentication/token mode for non-localhost deployments.

## 9. Open Implementation Questions

These can be decided during implementation or another design pass:

1. Exact Nuxt WebSocket implementation strategy under Nitro.
2. Exact install/load path for `@gotgenes/pi-permission-system` inside the Nuxt app:
   - installed as dependency and loaded via package resource discovery, or
   - copied/installed into Pi extension locations, or
   - added via `DefaultResourceLoader` additional paths if needed.
3. Shape of final normalized message reducer.
4. Whether to use Pinia immediately or defer until UI implementation starts.
5. Exact UI design/component library.
6. Exact heartbeat interval and approval timeout value.
