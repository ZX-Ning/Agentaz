# Frontend Development Guide

This document describes the current frontend direction for Agentaz. It is
intentionally lightweight and should evolve as the UI becomes more complete.

## Scope

The frontend lives in `packages/web-ui` as a Vite/Vue SPA that talks to the
Deno/Hono backend. The UI should feel like a simple ChatGPT-style coding
assistant:

- one active chat surface
- a sidebar for status and sessions
- a transcript area for user/assistant/tool output
- a bottom composer for prompts
- web approval UI for dangerous operations
- a single-user admin password page at `/login` before agent HTTP/SSE startup

The frontend should not introduce multi-user, project switching, or
database-backed concepts unless the product plan changes. The server already
owns loaded sessions; richer multi-tab/controller semantics remain future
product work until recorded in `docs/plan.md`.

## Location

Main frontend files:

```txt
packages/web-ui/src/app.vue
packages/web-ui/src/main.ts
packages/web-ui/src/views/LoginView.vue
packages/web-ui/src/views/AgentWorkspaceView.vue
packages/web-ui/src/components/
packages/web-ui/src/composables/
packages/web-ui/src/assets/css/main.css
```

The SPA does not use `vue-router`. `app.vue` chooses between `LoginView` and
`AgentWorkspaceView` from a small History API route store. Supported browser
paths are:

```txt
/login
/
/session/:sessionId
```

Unauthenticated app routes redirect to `/login?redirect=<original path>`.
Successful login returns to a safe same-origin redirect target or `/`.

In development, Vite proxies `/api` to `http://127.0.0.1:3000` by default.
Override that with `VITE_AGENTAZ_API_TARGET` or `AGENTAZ_API_TARGET` when the
API server runs elsewhere. `VITE_AGENTAZ_BASE_URL` may be used when the browser
should call an explicit API base instead of the current origin/base path.

## Styling and Theme

The SPA uses shadcn-vue-style local components built on Reka UI. Do not add Nuxt
UI or `U*` components to `packages/web-ui`.

Tailwind v4 semantic tokens are defined in:

```txt
packages/web-ui/src/assets/css/main.css
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

Do not hardcode broad gray palettes unless it is temporary. Prefer the semantic
classes above so light/dark mode remains consistent.

### Hardcoded color exceptions

Only small, localized status indicators may use hardcoded Tailwind colors
directly (e.g. `bg-amber-500`, `text-emerald-500`). These are limited to:

- Status dots (for example, tool block status dots in `ChatMessage.vue`)
- Inline error / warning text within otherwise theme-token-styled blocks

For any larger structural element — borders, backgrounds, text blocks, shadows —
always use the semantic tokens above.

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

Use normal Tailwind radius utilities such as `rounded-lg`; do not globally
override Tailwind utilities. Keep `rounded-full` only for true
circles/avatars/status dots.

### Font

IBM Plex Sans is imported from `src/main.ts` and applied globally in `main.css`.

## SSE Protocol

The frontend uses HTTP for browser-initiated actions and state snapshots, and
SSE (Server-Sent Events) only for realtime server events. The `/login` page must
complete before the agent workspace mounts, because the SSE endpoint requires
authentication:

```txt
/api/agent/events
```

The browser relies on a same-origin session cookie for both HTTP APIs and the
SSE request. The Deno/Hono backend uses a Better Auth encrypted stateless
cookie.

Protocol types live in:

```txt
packages/protocol/mod.ts
```

When protocol shapes change:

1. Update `packages/protocol/mod.ts`.
2. Update backend HTTP routes and SSE emitters.
3. Update frontend `apiFetch` calls and event handling.
4. Update Deno tests under `packages/api/test/` when handshake or required
   startup events change.

Prompt submissions use protocol v8 turn reconciliation. The browser generates
`clientMessageId` before `POST /api/agent/sessions/:sessionId/messages`, renders
a local optimistic user message, and replaces that local message when SSE
`turn_started` returns the canonical backend `UiMessage`. If the prompt fails,
`turn_failed` removes the optimistic/canonical placeholder and forces a history
refresh so Pi's persisted history remains authoritative. `status` and
`state_snapshot` update runtime UI only; transcript history should refresh from
explicit `turn_completed.transcriptRevision`, `turn_failed`, or direct user
actions such as fork/revert/reload.

`follow_up` messages currently mutate Pi's pending queue only. They do not
participate in optimistic transcript reconciliation and should not send
`clientMessageId` until the product has a dedicated queued-message protocol.

Important HTTP reads include:

```txt
GET /api/agent/state
GET /api/agent/models
GET /api/agent/sessions/:sessionId/history
GET /api/agent/sessions/:sessionId/entries
GET /api/agent/sessions/:sessionId/models
```

Important HTTP mutations include:

```txt
POST /api/agent/sessions/:sessionId/fork
POST /api/agent/sessions/:sessionId/revert
```

## Frontend State Model

Current state includes:

- login/session state from `useUserSession()`
- connection status
- server hello/cwd
- chat messages
- a local draft session shown before the first prompt creates a real backend
  session
- open, working, and available session summaries
- model list/current model
- streaming/pending queue state
- prompt text
- last error

Keep state normalized around `UiMessage` and `UiBlock` rather than raw Pi SDK
messages. The backend should translate Pi events into app-level protocol events.
Treat `loadedSessions` as the server-resident working set. Loaded sessions
should be focused with the session-specific focus endpoint; normal persisted
sessions should be opened on demand from `persistedSessions`. Loaded sessions
may include optional context/token usage metadata (`contextUsage` and
`usageStats`), refreshed via `status` SSE events and included in
`state_snapshot` responses. The header context menu renders these values for the
active loaded session. Manual context compact is a browser-triggered HTTP action
through `POST /api/agent/sessions/:sessionId/compact`; SSE/snapshots remain the
source of truth for refreshed usage after compact. Persisted Pi compaction
entries are projected by the backend history endpoint as concise `system`
messages, so the frontend should not add local-only compact markers. The initial
empty chat and the New session button use a frontend-only draft session. The
draft fetches model options through `GET /api/agent/models`, which does not
create a Pi session. It is not sent to the backend until the user submits the
first prompt; at that point the frontend creates a real session, applies the
selected model/thinking settings, moves the optimistic user message to the
returned session id, and submits the prompt. Real sessions are reflected in the
browser URL as `/session/:sessionId`. Draft sessions do not get a session route
and stay at `/`; after the first prompt materializes a draft, the frontend
replaces the URL with the returned real session id. Direct visits to
`/session/:sessionId` first focus an already-loaded session, then fall back to
the persisted session list by matching `sessionId` and opening the existing
`sessionFile`. Unauthenticated direct visits to any app route redirect to
`/login?redirect=<original path>`. Successful login returns to that redirect
target when it is a safe same-origin path.

## Chat Transcript

Render user and assistant messages differently:

- user messages: aligned right, primary background
- assistant messages: aligned left, card background
- tool events: dedicated tool call/result blocks inside the assistant turn
- thinking blocks: eventually collapsed by default

User and assistant text blocks render Markdown with Comark. Tool output, tool
results, and thinking blocks stay in plain `<pre>` rendering so command output
and internal reasoning text are not parsed as Markdown. `message_block_delta`
may append to text, thinking, or tool result blocks; tool result deltas should
update the block's `content` field, while text/thinking deltas update `text`.

The browser transcript should match the backend projection: one assistant
`UiMessage` per agent turn, with ordered blocks for text, thinking, tool calls,
and tool results. Reloaded HTTP history should render with the same grouping as
live SSE streaming.

History responses include a monotonic `revision`. The frontend should keep the
newest revision per session, ignore stale history responses, and keep
`mergeHistoryWithOptimisticMessages()` only as a recovery fallback for unusual
timing or older persisted data. The normal prompt confirmation path is
`clientMessageId`, not matching by prompt text. On `turn_failed`, remove the
matching optimistic/canonical user message before refreshing history; if Pi
persisted it, history will restore it.

Persisted history messages may include `UiMessage.entryId`, which identifies the
current-branch Pi session entry backing that rendered message, and
`UiMessage.rewindEntryId`, which identifies the previous current-branch entry.
The first fork/revert UI uses only user messages with a `rewindEntryId` as
anchors. Forking from a user message creates and focuses a new loaded session
before that message, then moves the message text into the composer. Reverting
asks for confirmation, then removes the user message from the current session,
moves its text into the composer, and reloads history.

## Composer Behavior

Current behavior:

- Send normal prompt when idle.
- Support `Ctrl/⌘ + Enter` to send.
- Stop button calls the HTTP abort endpoint.
- Clear Queue calls the HTTP queue clear endpoint.

Future behavior:

- If streaming, allow choosing between `steer` and `follow_up`; add an explicit
  queued-message UI/protocol before rendering follow-up as optimistic chat.
- Add attachment/image affordance only after backend image handling is
  implemented.

## Approval UI

Dangerous tool approvals are routed through backend extension UI events.
Frontend should eventually handle:

- `ui_confirm_request`
- `ui_select_request`
- `ui_input_request`
- matching HTTP response submissions

Approval UI should be prominent, modal or docked near the composer, and must
clearly show the action being approved.

## Extension Widgets

Extension widgets arrive through `extension_widget_update` events and are
rendered as plain text lines near the active transcript. The current
implementation is intentionally minimal and exists to support
`@juicesharp/rpiv-todo` before a fuller widget design is decided.

## Error Handling

Use backend `error` events and SSE failures to show:

- a visible alert in the main UI
- a toast for transient events

Do not silently swallow JSON parse failures or protocol mismatches during
development.
