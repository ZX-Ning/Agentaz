# Roadmap

This document captures likely future directions for Agentaz. It is not a commitment list; use it to preserve ideas without turning them into immediate implementation tasks.

## Current Product Theme

Build a reliable personal local/server-hosted agent experience powered by Pi:

- local-first by default
- one configured project directory
- one browser controller
- simple ChatGPT-like UX
- safe approval flow for dangerous tools
- session list/new/open
- model and thinking controls

The original MVP baseline is no longer the product boundary. This roadmap should capture possible directions without turning unconfirmed architecture into committed work.

## Near-Term Priorities

### 1. Solidify the Chat Loop

- Improve assistant streaming display.
- Render tool lifecycle events clearly.
- Add collapsed thinking blocks.
- Keep user messages and server-confirmed history from duplicating.
- Auto-scroll transcript carefully without fighting manual scroll.

### 2. Approval Experience

- Implement UI for `ui_confirm_request`.
- Implement UI for `ui_select_request`.
- Implement UI for `ui_input_request`.
- Show timeout state clearly.
- Show enough tool/context detail for informed decisions.
- Support approve once / approve session / deny where backend exposes it.

### 3. Session Management

- Make session list easier to scan.
- Add active session indicator.
- Add confirmation when switching during a running workflow.
- Add manual refresh.
- Consider naming sessions from first user prompt.

### 4. Model and Thinking Controls

- Add model picker UI.
- Add thinking level picker UI.
- Show pending model/thinking changes when a run is active.
- Clarify whether choices are session-only or can be promoted to defaults.

### 5. Protocol Hardening

- Add stronger frontend handling for unknown events.
- Improve error event codes.
- Keep smoke test aligned with handshake requirements.
- Consider protocol version compatibility checks in the browser.

## Frontend Improvements

- Split `app.vue` into components once behavior stabilizes.
- Add a dedicated socket composable.
- Add transcript virtualization if long sessions become slow.
- Add markdown rendering for assistant text.
- Add code block rendering with copy buttons.
- Add richer tool cards.
- Add responsive mobile sidebar/drawer.
- Add keyboard shortcuts for send/stop/new chat.
- Improve empty state and onboarding prompts.

## Backend Improvements

- Better normalization of Pi SDK event shapes after runtime testing.
- More precise status tracking around streaming/queued messages.
- Stronger cleanup on disconnect, abort, and takeover.
- More robust pending approval cancellation.
- More detailed backend smoke tests.
- Optional structured logs for debugging local sessions.

## Safety and Security

The current app has no auth and binds to localhost by default. Before any non-localhost or multi-user use:

- add authentication
- add CSRF/origin checks as appropriate
- review WebSocket exposure
- review filesystem/tool access assumptions
- document trust boundaries
- revisit permission config defaults

Do not make the app network-accessible by default without this work.

## Potential Future Features

### Multiple Clients

Possible evolution:

- multiple viewers, one controller
- explicit controller takeover
- shared transcript state
- per-client connection status

This likely requires replacing the single `WsAgentHub` peer model.

### Multiple Projects / cwd Switching

Potential project selector features:

- recent projects
- startup project list
- project switching from UI
- per-project permission configs

This likely requires session/runtime reinitialization and careful Pi SDK resource handling.

### File and Diff Views

Possible additions:

- file tree
- read-only file preview
- diff viewer for edit/write operations
- tool result previews
- apply/revert affordances if supported safely

### Persistence Beyond Pi Sessions

Possible additions:

- frontend UI preferences
- sidebar collapsed state
- recent prompts
- per-project display settings

Avoid adding a database until there is a concrete need. Prefer local storage for UI-only preferences.

### Packaging

Potential packaging directions:

- simple local CLI wrapper
- desktop wrapper
- single-command project launcher
- improved environment checks

## Documentation To Keep Updated

- `docs/plan.md`: product decisions and current baseline scope.
- `docs/frontend.md`: frontend structure, theming, protocol handling.
- `docs/backend.md`: backend architecture and Pi integration.
- `AGENTS.md`: instructions for coding agents working in this repo.

When a future idea becomes a committed decision, move it from this roadmap into the plan or relevant development guide.
