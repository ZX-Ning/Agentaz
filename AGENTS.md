# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Summary

Agentaz is a local-first Nuxt app for a general purpose / coding agent with a browser UI build on top of pi-sdk. The project has moved beyond the original MVP phase; docs should distinguish current implementation constraints from future product decisions.

Core architecture:

```txt
apps/web
├── app/                         Vue/Nuxt frontend
├── server/                      Nitro backend
│   ├── api/agent/               HTTP endpoints for browser actions/snapshots
│   ├── api/agent/events.get.ts  SSE endpoint for realtime server events
│   └── utils/
│       ├── agent-runtime.ts          process-wide runtime composition root
│       ├── pi-session-workspace.ts   Pi SDK services and loaded-session working set
│       ├── pi-session-controller.ts  per-loaded-session Pi operation controller
│       ├── session-projector.ts      browser-facing state snapshots
│       ├── client-presence.ts        browser focus/control presence
│       └── sse-agent-hub.ts          SSE subscribers and heartbeat snapshots
└── types/protocol.ts            HTTP DTOs and SSE event protocol types

docs
├── plan.md                      confirmed product decisions and baseline
├── backend.md                   backend implementation guidance
├── frontend.md                  frontend implementation guidance
└── implementation/              focused implementation notes and investigations
```

## Common Commands

Use pnpm from the repository root.

```bash
pnpm dev          # run Nuxt dev server
pnpm lint         # ESLint; assumes Nuxt has already generated .nuxt/eslint.config.mjs
pnpm typecheck    # TypeScript/Nuxt typecheck
pnpm build        # production build; run only when explicitly needed
pnpm test:api      # REST/SSE smoke test; requires dev server already running
pnpm smoke:backend # backend smoke test; requires dev server already running
```

Do not run `pnpm build` by default because it is slower. Run build only when requested or when changes affect build/runtime packaging. Do not run `pnpm dev` or start the dev server. If needed, ask the user to run them.

## Development Constraints

- Keep the app local-first and single-user unless explicitly asked otherwise.
- Do not add authentication or multi-user concepts without updating docs/plan.
- The backend should bind to `127.0.0.1` by default. Non-localhost bind is allowed only through env override and should warn loudly.
- The SSE hub is currently a process singleton.
- Browser-initiated actions should use HTTP APIs; SSE is for realtime server events only.
- Loaded Pi sessions are server-resident and should survive SSE detach.
- The agent `cwd` is startup-configured and is not currently selected in the web UI.
- Dangerous tool permissions should route through the web approval path, currently using `@gotgenes/pi-permission-system`.

## Code Style Expectations

- TypeScript everywhere.
- Keep protocol changes explicit in `apps/web/types/protocol.ts`.
- If adding/changing HTTP DTOs or SSE event shapes, update both frontend handling and backend emitters/routes.
- Prefer small, focused server utilities under `apps/web/server/utils/`.
- Keep frontend state simple until there is a strong reason to introduce a larger store.

### Comments

Write comments proactively, especially around API boundaries, non-obvious contracts, lifecycle behavior, and long functions. Keep them technically precise and linguistically concise: prefer short JSDoc, compact inline notes, lists, arrows, and symbols over paragraph-style explanation. Comments should clarify intent, invariants, side effects, error behavior, and phase boundaries without becoming essays.

## Development Guides

Before changing frontend code, read `docs/frontend.md` for UI structure,
theming, protocol handling, state shape, and transcript behavior.

Before changing backend code, read `docs/backend.md` for runtime ownership,
route boundaries, Pi SDK integration, session behavior, permissions, and
protocol rules.

Use `docs/implementation/` for focused implementation notes when the task
touches extension loading, session performance, or another documented
investigation.

## Testing / Verification

Minimum verification after code edits:

```bash
pnpm lint
pnpm typecheck
```

`pnpm lint` does not run `nuxt prepare`; in a fresh checkout, run `pnpm typecheck`
or another Nuxt prepare/type generation command first so `.nuxt/eslint.config.mjs`
exists.

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
- `docs/implementation/`: focused implementation notes for specific backend/frontend choices.

## Things Not To Do Without Asking

- DO NOT add authentication, user accounts, database persistence, or SaaS/team concepts.
- DO NOT add project/cwd switching in the UI.
- DO NOT remove the Pi permission-system integration.
- DO NOT run broad formatting or rewrite unrelated files.
- DO NOT overwrite existing working-tree changes. If the working tree already has
  large changes, or existing changes would affect the current implementation,
  pause editing and ask whether they should be committed first.
- DO NOT commit changes unless the user asks.

Before committing, run:

```bash
npx prettier --write .
```
