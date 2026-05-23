# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Summary

Agentaz is a local-first Nuxt app for a Pi SDK-powered coding agent with a browser UI. The project has moved beyond the original MVP phase; docs should distinguish current implementation constraints from future product decisions.

Core architecture:

- `apps/web`: Nuxt fullstack app.
- `apps/web/app`: Vue/Nuxt frontend.
- `apps/web/server`: Nitro backend.
- `apps/web/server/api/agent`: HTTP endpoints for browser-initiated agent actions and snapshots.
- `apps/web/server/routes/api/agent/ws.ts`: WebSocket endpoint for realtime server events.
- `apps/web/server/utils/pi-session-registry.ts`: process-wide server-resident Pi session registry.
- `apps/web/server/utils/ws-agent-hub.ts`: WebSocket subscriber lifecycle and heartbeat snapshots.
- `apps/web/types/protocol.ts`: HTTP DTOs and WebSocket event protocol types.
- `docs/plan.md`: confirmed product decisions and current baseline.

## Common Commands

Use pnpm from the repository root.

```bash
pnpm dev          # run Nuxt dev server
pnpm typecheck    # TypeScript/Nuxt typecheck
pnpm build        # production build; run only when explicitly needed
pnpm test:api      # REST/WS smoke test; requires dev server already running
pnpm smoke:backend # backend smoke test; requires dev server already running
```

After normal code edits, run:

```bash
pnpm typecheck
```

Do not run `pnpm build` by default because it is slower. Run build only when requested or when changes affect build/runtime packaging. Do not run `pnpm dev` or start the dev server. If needed, ask the user to run them.

## Development Constraints

- Keep the app local-first and single-user unless explicitly asked otherwise.
- Do not add authentication or multi-user concepts without updating docs/plan.
- The backend should bind to `127.0.0.1` by default. Non-localhost bind is allowed only through env override and should warn loudly.
- The WebSocket hub is currently a process singleton.
- Browser-initiated actions should use HTTP APIs; WebSocket is for realtime server events only.
- Loaded Pi sessions are server-resident and should survive WebSocket detach.
- The agent `cwd` is startup-configured and is not currently selected in the web UI.
- Dangerous tool permissions should route through the web approval path, currently using `@gotgenes/pi-permission-system`.

## Code Style Expectations

- TypeScript everywhere.
- Keep protocol changes explicit in `apps/web/types/protocol.ts`.
- If adding/changing HTTP DTOs or WebSocket event shapes, update both frontend handling and backend emitters/routes.
- Prefer small, focused server utilities under `apps/web/server/utils/`.
- Keep frontend state simple until there is a strong reason to introduce a larger store.
- All `interface` and `class` declarations should have documentation comments explaining purpose and behavior.
- Interface methods should have documentation comments explaining expected behavior and implementation constraints.
- For long functions/methods, add short section comments when they clarify flow.

## Frontend Notes

- Nuxt UI is installed and enabled.
- Theme tokens live in `apps/web/app/assets/css/main.css`.
- Use semantic Tailwind classes based on project tokens, for example:
  - `bg-background`
  - `text-foreground`
  - `bg-card`
  - `border-border`
  - `bg-primary`
  - `text-primary-foreground`
  - `bg-sidebar`
- Use the configured radius through normal Tailwind radius utilities such as `rounded-lg`.
- Do not globally override Tailwind utilities like `.rounded-full`.
- Current font is IBM Plex Sans loaded through Nuxt head config.

## Backend Notes

- Keep Pi SDK code server-side only.
- `PiSessionRegistry` should own loaded Pi session lifecycle and browser-facing agent operations.
- `WsAgentHub` should own browser WebSocket attach/detach and heartbeat snapshots only.
- HTTP route files under `apps/web/server/api/agent` should stay thin and delegate to `PiSessionRegistry`.
- `WebExtensionUIContext` bridges extension UI prompts/approvals to the browser.
- `permission-config.ts` creates project-level permission-system config under `<cwd>/.pi/extensions/pi-permission-system/config.json`.

## Testing / Verification

Minimum verification after code edits:

```bash
pnpm typecheck
```

For backend protocol changes, also consider:

```bash
# terminal 1
pnpm dev

# terminal 2
pnpm smoke:backend
```

## Documentation Updates

Update docs when changing product decisions or architecture:

- `docs/plan.md`: canonical product decisions and current baseline.
- `docs/frontend.md`: frontend implementation guidance.
- `docs/backend.md`: backend implementation guidance.
- `docs/roadmap.md`: future ideas and direction.

## Things Not To Do Without Asking

- Add authentication, user accounts, database persistence, or SaaS/team concepts.
- Add project/cwd switching in the UI.
- Replace the WebSocket protocol with HTTP polling or SSE.
- Remove the Pi permission-system integration.
- Run broad formatting or rewrite unrelated files.
- Commit changes unless the user asks.
