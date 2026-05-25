# Frontend Development Guide

This document describes the current frontend direction for Agentaz. It is intentionally lightweight and should evolve as the UI becomes more complete.

## Scope

The frontend is a Nuxt/Vue browser UI for a Pi SDK agent. The current UI should feel like a simple ChatGPT-style coding assistant:

- one active chat surface
- a sidebar for status and sessions
- a transcript area for user/assistant/tool output
- a bottom composer for prompts
- web approval UI for dangerous operations

The frontend should not introduce multi-user, authentication, project switching, or database-backed concepts unless the product plan changes. The server already owns loaded sessions; richer multi-tab/controller semantics remain future product work until recorded in `docs/plan.md`.

## Location

Main frontend files:

```txt
apps/web/app/app.vue
apps/web/app/assets/css/main.css
apps/web/types/protocol.ts
```

Current app state is local to `app.vue`. Extract composables/components when the file becomes too large or when behavior needs reuse.

Suggested future structure:

```txt
apps/web/app/
  app.vue
  assets/css/main.css
  components/
    AppSidebar.vue
    ChatTranscript.vue
    ChatMessage.vue
    ChatComposer.vue
    ApprovalDialog.vue
  composables/
    useAgentSocket.ts
    useAgentMessages.ts
```

## Styling and Theme

Nuxt UI is installed and enabled. Tailwind v4 semantic tokens are defined in:

```txt
apps/web/app/assets/css/main.css
```

Use semantic Tailwind classes mapped from the project palette:

```txt
bg-background
text-foreground
bg-card
text-card-foreground
bg-muted
text-muted-foreground
bg-primary
text-primary-foreground
bg-secondary
text-secondary-foreground
bg-accent
text-accent-foreground
border-border
border-input
bg-sidebar
text-sidebar-foreground
border-sidebar-border
```

Do not hardcode broad gray palettes unless it is temporary. Prefer the semantic classes above so light/dark mode remains consistent.

### Radius

The design radius is configured as:

```css
--radius: 0.45rem;
```

Use normal Tailwind radius utilities such as `rounded-lg`; do not globally override Tailwind utilities. Keep `rounded-full` only for true circles/avatars/status dots.

### Font

IBM Plex Sans is loaded in Nuxt head config and applied globally in `main.css`.

## WebSocket Protocol

The frontend uses HTTP for browser-initiated actions and state snapshots, and WebSocket only for realtime server events. The WebSocket connects to:

```txt
/api/agent/ws
```

Protocol types live in:

```txt
apps/web/types/protocol.ts
```

When protocol shapes change:

1. Update `types/protocol.ts`.
2. Update backend HTTP routes and WebSocket emitters.
3. Update frontend `$fetch` calls and event handling.
4. Consider updating `scripts/smoke-backend.mjs` if handshake or required startup events change.

Important HTTP reads include:

```txt
GET /api/agent/state
GET /api/agent/models
GET /api/agent/sessions/:sessionId/history
GET /api/agent/sessions/:sessionId/models
```

## Frontend State Model

Current state includes:

- connection status
- server hello/cwd
- chat messages
- a local draft session shown before the first prompt creates a real backend session
- open, working, and available session summaries
- model list/current model
- streaming/pending queue state
- prompt text
- last error

Keep state normalized around `UiMessage` and `UiBlock` rather than raw Pi SDK messages. The backend should translate Pi events into app-level protocol events.
Treat `loadedSessions` as the server-resident working set. Loaded sessions should be focused with the session-specific focus endpoint; normal persisted sessions should be opened on demand from `persistedSessions`.
The initial empty chat and the New session button use a frontend-only draft session. The draft fetches model options through `GET /api/agent/models`, which does not create a Pi session. It is not sent to the backend until the user submits the first prompt; at that point the frontend creates a real session, applies the selected model/thinking settings, moves the optimistic user message to the returned session id, and submits the prompt.

## Chat Transcript

Render user and assistant messages differently:

- user messages: aligned right, primary background
- assistant messages: aligned left, card background
- tool events: initially textual summaries; later extract dedicated tool blocks
- thinking blocks: eventually collapsed by default

User and assistant text blocks render Markdown with Comark. Tool output, tool results, and thinking blocks stay in plain `<pre>` rendering so command output and internal reasoning text are not parsed as Markdown.

## Composer Behavior

Current behavior:

- Send normal prompt when idle.
- Support `Ctrl/⌘ + Enter` to send.
- Stop button calls the HTTP abort endpoint.
- Clear Queue calls the HTTP queue clear endpoint.

Future behavior:

- If streaming, allow choosing between `steer` and `follow_up`.
- Add attachment/image affordance only after backend image handling is implemented.

## Approval UI

Dangerous tool approvals are routed through backend extension UI events. Frontend should eventually handle:

- `ui_confirm_request`
- `ui_select_request`
- `ui_input_request`
- matching HTTP response submissions

Approval UI should be prominent, modal or docked near the composer, and must clearly show the action being approved.

## Extension Widgets

Extension widgets arrive through `extension_widget_update` events and are rendered as plain text lines near the active transcript. The current implementation is intentionally minimal and exists to support `@juicesharp/rpiv-todo` before a fuller widget design is decided.

## Error Handling

Use backend `error` events and websocket failures to show:

- a visible alert in the main UI
- a toast for transient events

Do not silently swallow JSON parse failures or protocol mismatches during development.

## Verification

After frontend code changes, run from repository root:

```bash
pnpm typecheck
```

Run `pnpm build` only when requested or when changing build/runtime packaging.
