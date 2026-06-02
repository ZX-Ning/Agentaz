# Session Performance Notes

This document records the investigation into large delays when creating or opening sessions in the Agentaz backend.

## Summary

Opening an already persisted session for viewing should be fast. New session creation used to be slow because each session creation called the Pi SDK's full `createAgentSession()` path, which reloads SDK resources and TypeScript extensions.

**2026-06-02: The process-wide SDK services reuse optimization has been removed.** Sharing a single `AgentSessionServices`/resource loader/extension runtime across multiple loaded sessions was found to cause stale extension context errors when one session was disposed while another session's extensions (especially `@gotgenes/pi-permission-system` pollers) were still active. Each loaded `PiSessionController` now owns its own services instance. AuthStorage and ModelRegistry remain shared at the workspace level because they are not extension runtimes.

This means session creation/opening may again pay the extension loading cost per loaded session. Future optimization must preserve per-session extension runtime isolation or require SDK/upstream changes to support safe multi-session service sharing.

See `docs/backend.md` and `docs/implementation/pi-extension-runtime-isolation.md` for the isolation design and stale context error investigation.

Current expected behavior:

- Opening an unloaded persisted session for viewing should be tens of milliseconds.
- Creating a new session after Pi SDK services are warm should be tens of milliseconds or less.
- The first SDK services initialization in a process can still take around one second because SDK extensions are loaded then.
- Opening the Web UI or clicking New session should not create a real Pi session. The frontend keeps a local draft and materializes it on the first user prompt.
- Draft sessions may read model picker defaults through `GET /api/agent/models`; that endpoint uses `ModelRegistry` only and should not create or initialize a Pi session.

## Measured Call Costs

The investigation used direct localhost HTTP timing and small Node scripts from `apps/web` to call Pi SDK APIs directly.

Observed end-to-end HTTP timings:

- `POST /api/agent/sessions` before SDK service reuse: about `2.284s`.
- `POST /api/agent/sessions` to open an unloaded persisted session after lazy open: about `0.025s`.
- `GET /api/agent/sessions/:sessionId/history` after lazy open: about `0.021s`.
- `GET /api/agent/sessions/:sessionId/models` after lazy open: about `0.027s`.
- New session after SDK service reuse, first call while services are still cold: about `0.879s`.
- New session after SDK service reuse, second call with warm services: about `0.009s`.

Direct SDK timing showed:

- `ensurePermissionConfig`: about `0.7ms`.
- `AuthStorage.create`: about `3ms`.
- `ModelRegistry.create`: about `4ms`.
- `SessionManager.create`: about `2ms`.
- `sessionManager.newSession`: about `0.2ms`.
- `createAgentSession`: about `845ms`.
- `session.bindExtensions`: about `0.4ms`.

The large delay was therefore inside `createAgentSession()`, not route handling, permission config, session file creation, or browser-backed extension UI binding.

## SDK Root Cause

The Pi SDK `createAgentSession()` default path constructs a `DefaultResourceLoader` and calls `resourceLoader.reload()`.

`DefaultResourceLoader.reload()` performs resource discovery/loading for:

- settings
- package-managed resources
- extensions
- skills
- prompt templates
- themes
- project/global context files

Measured resource loader variants:

- Default reload: about `930ms`.
- `noExtensions: true`: about `5ms`.
- `noSkills: true`: about `830ms`.
- `noPromptTemplates: true`: about `853ms`.
- `noThemes: true`: about `826ms`.
- `noContextFiles: true`: about `794ms`.
- Empty loader passed directly to `createAgentSession()`: about `2.8ms`.

This isolates the dominant cost to extension loading. The active extensions at the time of investigation were:

- `/home/zxning/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo/index.ts`
- `/home/zxning/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question/index.ts`
- `/home/zxning/.pi/agent/npm/node_modules/pi-hashline-readmap/index.ts`

Measured per-extension reload costs:

- `@juicesharp/rpiv-todo`: about `107ms`.
- `@juicesharp/rpiv-ask-user-question`: about `201ms`.
- `pi-hashline-readmap`: about `574ms`.

The likely cause is repeated TypeScript extension loading through `jiti`, especially for `pi-hashline-readmap`.

## Backend Fix (Historical — Replaced by Per-Session Isolation)

Agentaz previously kept a process-wide `PiSessionWorkspace` with a cached services promise for the configured `cwd`. Session controllers used those services instead of calling full `createAgentSession()` for every loaded session. This gave the performance numbers shown below.

**This approach has been replaced.** The shared services included a shared resource loader and extension runtime. When one session was disposed, the SDK invalidated the runtime/context, causing stale context errors in other loaded sessions. Each controller now gets its own isolated services. See `docs/implementation/pi-extension-runtime-isolation.md`.

The historical measurements below remain useful for understanding SDK costs and evaluating future multi-session performance optimization approaches.

## Debugging Guidance

If new session creation becomes slow again, first check whether SDK services are being recreated per session. The key symptom is repeated `DefaultResourceLoader.reload()` cost on each `POST /api/agent/sessions`.

Useful direct measurements:

```bash
time curl -sS -X POST http://127.0.0.1:3000/api/agent/sessions > /tmp/agentaz-new-session.json
```

To isolate SDK costs, run Node scripts from `apps/web` so `@earendil-works/pi-coding-agent` resolves correctly. Compare:

- direct `createAgentSession()`
- `createAgentSession()` with an empty resource loader
- `DefaultResourceLoader.reload()` with `noExtensions: true`
- `createAgentSessionServices()` once plus repeated `createAgentSessionFromServices()`

If deeper debugging is needed, put breakpoints or timing logs in the SDK path:

- `dist/core/sdk.js:createAgentSession()`
- `dist/core/resource-loader.js:DefaultResourceLoader.reload()`
- `dist/core/extensions/loader.js:loadExtensions()` and per-extension `loadExtension()`

The most useful breakpoint is around extension module loading in `loadExtensionModule()`, because the measured bottleneck is TypeScript extension import/initialization rather than Agentaz route code.
