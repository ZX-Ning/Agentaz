# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Summary

Agentaz is a local-first Nuxt web UI for a Pi SDK-powered coding agent. The MVP is a personal browser version of Pi running against one startup-selected working directory.

Core architecture:

- `apps/web`: Nuxt fullstack app.
- `apps/web/app`: Vue/Nuxt frontend.
- `apps/web/server`: Nitro backend.
- `apps/web/server/routes/api/agent/ws.ts`: WebSocket endpoint for agent commands/events.
- `apps/web/server/utils/pi-agent-service.ts`: Pi SDK session orchestration.
- `apps/web/server/utils/ws-agent-hub.ts`: process-wide WebSocket hub and single-client policy.
- `apps/web/types/protocol.ts`: browser/server wire protocol types.
- `docs/plan.md`: detailed MVP decisions and product plan.

## Common Commands

Use pnpm from the repository root.

```bash
pnpm dev          # run Nuxt dev server
pnpm typecheck    # TypeScript/Nuxt typecheck
pnpm build        # production build; run only when explicitly needed
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
- The WebSocket hub is intentionally a process singleton for the MVP.
- There is only one active browser client at a time. `?force=1` may be used for takeover.
- The agent `cwd` is startup-configured, not selected in the web UI for MVP.
- Dangerous tool permissions should route through the web approval path, currently using `@gotgenes/pi-permission-system`.

## Code Style Expectations

- TypeScript everywhere.
- Keep protocol changes explicit in `apps/web/types/protocol.ts`.
- If adding/changing WebSocket event shapes, update both frontend handling and backend emitters.
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
- `PiAgentService` should own Pi session lifecycle and command handling.
- `WsAgentHub` should own browser connection lifecycle, heartbeat, single-client rejection, force takeover, and cleanup.
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

- `docs/plan.md`: canonical MVP/product decisions.
- `docs/frontend.md`: frontend implementation guidance.
- `docs/backend.md`: backend implementation guidance.
- `docs/roadmap.md`: post-MVP ideas and future direction.

## Things Not To Do Without Asking

- Add authentication, user accounts, database persistence, or SaaS/team concepts.
- Add project/cwd switching in the UI.
- Replace the WebSocket protocol with HTTP polling or SSE.
- Remove the Pi permission-system integration.
- Run broad formatting or rewrite unrelated files.
- Commit changes unless the user asks.
