# Frontend Development Guide

This document describes the current frontend direction for Agentaz. It is intentionally lightweight and should evolve as the UI becomes more complete.

## Scope

The frontend is a Nuxt/Vue browser UI for a Pi SDK agent. The current UI should feel like a simple ChatGPT-style coding assistant:

- one active chat surface
- a sidebar for status and sessions
- a transcript area for user/assistant/tool output
- a bottom composer for prompts
- web approval UI for dangerous operations
- a single-user admin password page at `/login` before agent HTTP/WS startup

The frontend should not introduce multi-user, project switching, or database-backed concepts unless the product plan changes. The server already owns loaded sessions; richer multi-tab/controller semantics remain future product work until recorded in `docs/plan.md`.

## Location

Main frontend files:

```txt
apps/web/app/app.vue
apps/web/app/pages/login.vue
apps/web/app/pages/index.vue
apps/web/app/middleware/auth.global.ts
apps/web/app/assets/css/main.css
apps/web/types/protocol.ts
```

`app.vue` is only the Nuxt shell around `NuxtPage`. It gives protected app
routes a stable page key so navigation inside the agent workspace stays
SPA-like and does not recreate the WebSocket client. Route-specific UI lives in
file routes, with `/login` as the public login page. The protected workspace
lives in `pages/index.vue`, which also declares `/session/:sessionId` as a Nuxt
route alias. Authentication redirects live in `auth.global.ts`.

Suggested future structure:

```txt
apps/web/app/
  app.vue
  components/AgentWorkspace.vue
  pages/
    login.vue
    index.vue
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

### Hardcoded color exceptions

Only small, localized status indicators may use hardcoded Tailwind colors directly (e.g. `bg-amber-500`, `text-emerald-500`). These are limited to:

- Status dots (see `StatusPopover.vue` dots, tool block status dots in `ChatMessage.vue`)
- Inline error / warning text within otherwise theme-token-styled blocks

For any larger structural element — borders, backgrounds, text blocks, shadows — always use the semantic tokens above.

### Shadows

Shadow colors must follow the same theme-token convention:

```txt
shadow-foreground/10                     (light mode)
dark:shadow-foreground/10                (dark mode)
```

Do not use `shadow-black/...` or other hardcoded shadow colors.

### Radius

The design radius is configured as:

```css
--radius: 0.45rem;
```

Use normal Tailwind radius utilities such as `rounded-lg`; do not globally override Tailwind utilities. Keep `rounded-full` only for true circles/avatars/status dots.

### Font

IBM Plex Sans is loaded in Nuxt head config and applied globally in `main.css`.

## WebSocket Protocol

The frontend uses HTTP for browser-initiated actions and state snapshots, and WebSocket only for realtime server events. The `/login` page must complete before the agent workspace mounts, because the WebSocket connects to a protected endpoint:

```txt
/api/agent/ws
```

The browser relies on the same-origin `nuxt-auth-utils` session cookie for both
HTTP APIs and the WebSocket upgrade.

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

- login/session state from `useUserSession()`
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
Real sessions are reflected in the browser URL as `/session/:sessionId`. Draft sessions do not get a session route and stay at `/`; after the first prompt materializes a draft, the frontend replaces the URL with the returned real session id. Direct visits to `/session/:sessionId` first focus an already-loaded session, then fall back to the persisted session list by matching `sessionId` and opening the existing `sessionFile`.
Unauthenticated direct visits to any app route redirect to `/login?redirect=<original path>`. Successful login returns to that redirect target when it is a safe same-origin path.

## Chat Transcript

Render user and assistant messages differently:

- user messages: aligned right, primary background
- assistant messages: aligned left, card background
- tool events: dedicated tool call/result blocks inside the assistant turn
- thinking blocks: eventually collapsed by default

User and assistant text blocks render Markdown with Comark. Tool output, tool results, and thinking blocks stay in plain `<pre>` rendering so command output and internal reasoning text are not parsed as Markdown. `message_block_delta` may append to text, thinking, or tool result blocks; tool result deltas should update the block's `content` field, while text/thinking deltas update `text`.

The browser transcript should match the backend projection: one assistant `UiMessage` per agent turn, with ordered blocks for text, thinking, tool calls, and tool results. Reloaded HTTP history should render with the same grouping as live WebSocket streaming.

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
