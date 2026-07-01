# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Summary

Agentaz is a local-first general purpose / coding agent with a browser UI built
on top of pi-sdk.

The repository is a Deno workspace with a backend/frontend split:

- Shared HTTP DTO and SSE protocol types live under `packages/protocol`.
- The Hono backend lives under `packages/api`.
- The Vite/Vue frontend lives under `packages/web-ui`.

Docs should distinguish current implementation constraints from future product
decisions.

Core architecture:

```txt
deno.json                         Deno workspace root

packages
├── protocol/                     Shared HTTP DTO and SSE protocol types
│   └── mod.ts
├── api/                          Deno/Hono backend package
│   ├── src/
│   │   ├── main.ts               Hono app assembly and runtime startup
│   │   ├── routes/               Hono route modules mounted under /api
│   │   ├── auth/                 Better Auth encrypted stateless cookie auth
│   │   ├── http/                 Hono request/error helpers
│   │   ├── runtime/              Runtime composition, presence, events, SSE hub
│   │   ├── pi/                   Pi SDK session workspace/controller
│   │   ├── extensions/           Extension UI bridge and permission config
│   │   └── errors.ts             Domain error classes
│   └── test/                     Deno backend tests
└── web-ui/                       Vite/Vue frontend package
    └── src/
        ├── app.vue               Root app shell and route selection
        ├── main.ts               Vue app bootstrap and global components
        ├── views/                Login and agent workspace views
        ├── components/           Workspace, chat, sidebar, and UI components
        ├── composables/          API, SSE, session, routing, and UI state
        ├── assets/css/           Tailwind v4 theme tokens and global CSS
        ├── types/                Frontend-local TypeScript types
        └── utils/                Transcript/session list helpers

docs
├── plan.md                      confirmed product decisions and baseline
├── backend.md                   backend implementation guidance
├── frontend.md                  frontend implementation guidance
└── implementation/              focused implementation notes and investigations
```

## Common Commands

Use Deno from the repository root:

```bash
deno task check        # Deno workspace typecheck for API and web UI
deno task test         # Deno backend tests
deno task serve        # run the Hono API server on 127.0.0.1:3000
deno task dev:web-ui   # run the Vite/Vue dev server
deno task build:web-ui # production frontend build; run only when needed
```

If `deno` is not on PATH, use the local installation path for your environment.

Do not run `deno task build:web-ui` by default because it is slower. Run build
only when requested or when changes affect build/runtime packaging. Do not run
`deno task dev:web-ui` or start the dev server unless the user asks. Do not
start a Deno API server unless the user asks for a runtime smoke test.

## Development Constraints

- Keep the app local-first and single-user unless explicitly asked otherwise.
- Do not add authentication or multi-user concepts without updating docs/plan.
- The backend should bind to `127.0.0.1` by default. Non-localhost bind is
  allowed only through env override and should warn loudly.
- The SSE hub is currently a process singleton.
- Browser-initiated actions should use HTTP APIs; SSE is for realtime server
  events only.
- Loaded Pi sessions are server-resident and should survive SSE detach.
- The agent `cwd` is startup-configured and is not currently selected in the web
  UI.
- Dangerous tool permissions should route through the web approval path,
  currently using `@gotgenes/pi-permission-system`.

## Code Style Expectations

- TypeScript everywhere.
- Keep protocol changes explicit in `packages/protocol/mod.ts`.
- If adding/changing HTTP DTOs or SSE event shapes, update both frontend
  handling and backend emitters/routes.
- Prefer small, focused modules under
  `packages/api/src/{auth,http,routes,runtime,pi,extensions}` for the Deno
  backend.
- Hono route files should export route-local `Hono` apps;
  `packages/api/src/main.ts` assembles them and exports the app for
  `deno serve`.
- Keep frontend changes scoped under `packages/web-ui/src/` unless docs,
  protocol, or build configuration also need to change.
- Keep frontend state simple until there is a strong reason to introduce a
  larger store.

### Comments

Write comments proactively, especially around API boundaries, non-obvious
contracts, lifecycle behavior, and long functions. Keep them technically precise
and linguistically concise: prefer short JSDoc, compact inline notes, lists,
arrows, and symbols over paragraph-style explanation. Comments should clarify
intent, invariants, side effects, error behavior, and phase boundaries without
becoming essays.

### Formatting

- Use `deno fmt <file|directory>` for formatting.
- Format changed files before each commit.
- Only format files that are part of the current commit; do not bulk-format
  unrelated files.

## Development Guides

Before changing frontend code, read `docs/frontend.md` for UI structure,
theming, protocol handling, state shape, and transcript behavior.

Before changing backend code, read `docs/backend.md` for runtime ownership,
route boundaries, Pi SDK integration, session behavior, permissions, and
protocol rules.

Use `docs/implementation/` for focused implementation notes when the task
touches extension loading, session performance, or another documented
investigation.

> **Note**: `docs/implementation/` mixes current focused notes with historical
> investigations. Check each document's status before using paths or commands as
> implementation guidance.

## Testing / Verification

Minimum verification after code edits:

For Deno package edits:

```bash
deno task check
deno task test
```

For frontend-only edits:

```bash
deno task check:web-ui
```

For backend protocol changes, run `deno task check` and `deno task test`.

## Documentation Updates

Update docs when changing product decisions or architecture:

- `docs/plan.md`: canonical product decisions and current baseline.
- `docs/frontend.md`: frontend implementation guidance.
- `docs/backend.md`: backend implementation guidance.

## Things Not To Do Without Asking

- DO NOT add authentication, user accounts, database persistence, or SaaS/team
  concepts.
- DO NOT add project/cwd switching in the UI.
- DO NOT remove the Pi permission-system integration.
- DO NOT run broad formatting or rewrite unrelated files.
- DO NOT overwrite existing working-tree changes. If the working tree already
  has large changes, or existing changes would affect the current
  implementation, pause editing and ask whether they should be committed first.
- DO NOT commit changes unless the user asks.

## Communication style:

Maintain technical precision and professional engineering judgment, but avoid
overusing obscure, corporate, overly formal, or unnecessarily
“enterprise-sounding” language in normal conversation.

The user is a professional programmer. Do not explain concepts as if they have
no coding experience. Prefer concise, practical, engineer-to-engineer
communication.

Use plain language when possible. Keep responses short and focused. When a
simple visual structure helps, use lightweight diagrams such as arrows,
dependency chains, or small code-shaped sketches to reduce long explanations.

Examples of preferred style:

- “A → B → C” instead of a long causal paragraph.
- “This function owns X; the caller owns Y.”
- “The bug is likely here: …”
- “Tradeoff: simpler API, but less flexibility.”

Avoid:

- Excessive business jargon.
- Over-polished consulting-style phrasing.
- Long motivational or beginner-level explanations.
- Explaining obvious programming basics unless the user asks.
