# Pi Extension Runtime Isolation Plan (Historical)

This document records the completed plan that fixed recurring stale Pi extension
context errors in Agentaz. It is intentionally detailed because the issue
crossed Agentaz session ownership, Pi SDK service reuse, and
`@gotgenes/pi-permission-system` timer lifecycle.

The current implementation lives in `packages/api/src/pi/session-workspace.ts`
and `packages/api/src/pi/session-controller.ts`. Treat the implementation prompt
near the end of this document as historical context, not current instructions.

## Problem Summary

At the time of the investigation, Agentaz kept Pi SDK services in a process-wide
cached promise inside `PiSessionWorkspace`. Multiple loaded sessions then called
`createAgentSessionFromServices()` with the same `AgentSessionServices`
instance. This was introduced for performance: extension loading is expensive,
and sharing services made subsequent session creation nearly instant.

That optimization is not safe with the current Pi SDK extension runtime model.
The shared services include a shared `resourceLoader`, and the resource loader's
loaded extensions share one extension runtime object. Each `AgentSession`
creates its own `ExtensionRunner`, but those runners are backed by the same
extension runtime. When one session is disposed, the SDK invalidates that
runtime/context. Other loaded sessions that still reference the same runtime can
then hit stale context errors.

Observed errors:

```txt
[unhandledRejection] Error: This extension ctx is stale after session replacement or reload...
    at ExtensionRunner.assertActive
    at get hasUI
    at processForwardedPermissionRequests
    at Timeout._onTimeout
```

and:

```txt
[agentaz-server] extension error {
  extensionPath: ".../@gotgenes/pi-permission-system/src/index.ts",
  event: "before_agent_start",
  error: "This extension ctx is stale after session replacement or reload..."
}
```

The first error comes from a permission-system forwarding poller continuing to
use a captured stale `ExtensionContext`. The second error comes from a later
`before_agent_start` handler calling `pi.getAllTools()` through a stale shared
extension API/runtime.

## Confirmed Root Cause

The relevant Agentaz code paths are:

- `PiSessionWorkspace.getServices()` caches one `AgentSessionServices` promise
  for the whole process.
- `PiSessionController.initializeSession()` calls
  `createAgentSessionFromServices({ services, sessionManager })`.
- `PiSessionController.dispose()` currently cancels browser UI prompts,
  unsubscribes from session events, and calls `session.dispose()`.

The relevant SDK/extension behavior is:

- `createAgentSessionServices()` creates a `DefaultResourceLoader`, reloads
  resources, and loads extensions.
- `createAgentSessionFromServices()` passes that same resource loader into each
  new `AgentSession`.
- `AgentSession._buildRuntime()` creates a new `ExtensionRunner`, but it reads
  `extensionsResult.runtime` from the shared resource loader.
- `AgentSession.dispose()` invalidates the extension runner/runtime so later
  accessors throw the stale context error.
- `@gotgenes/pi-permission-system` starts a `ForwardingManager` interval when it
  receives a UI-capable `ExtensionContext`.
- The forwarding interval is stopped only when the extension receives
  `session_shutdown`; a direct `session.dispose()` does not emit that event.

Two SDK-level reproductions confirmed the issue:

1. Create two sessions from one shared services instance, bind extensions on
   both, dispose the first, then emit `before_agent_start` on the second. The
   second session reports a stale ctx extension error from permission-system.
2. Create one UI-bound session, emit `before_agent_start` so permission-system
   starts forwarding, call `session.dispose()` without `session_shutdown`, then
   wait longer than the poll interval. Repeated unhandled stale ctx rejections
   are emitted from the forwarding timer.

## Goals

- Stop recurring stale ctx unhandled rejections.
- Keep multiple loaded sessions usable after any other loaded session is
  evicted, deleted, reverted, or disposed.
- Keep `@gotgenes/pi-permission-system` installed and active.
- Preserve the existing HTTP/SSE protocol.
- Prefer correctness over the previous fast session creation optimization.

## Non-Goals

- Do not add authentication, multi-user behavior, project switching, or database
  persistence.
- Do not remove or disable the permission-system integration.
- Do not introduce a new frontend state model.
- Do not depend on patching files under `.pi/agent/npm/node_modules`.
- Do not run `pnpm dev` from the implementation agent; ask the user if a dev
  server is needed for manual smoke testing.

## Target Design

Each loaded `PiSessionController` should own its own Pi SDK
`AgentSessionServices` instance. It may still share simple process-wide backing
objects that are not extension runtimes:

- `AuthStorage`
- `ModelRegistry`
- configured `cwd`
- configured `agentDir`

The session-specific services must include a session-specific resource loader
and extension runtime. Disposing one controller must not invalidate another
controller's extension runner or extension API.

Package/config setup can stay workspace-level:

- Required Pi package settings are still ensured in the Pi agent directory.
- Permission config is still ensured before binding a controller's extensions.

The workspace should no longer prewarm a single shared extension services
instance. If a future performance optimization is needed, it should be designed
with explicit SDK/upstream support for multi-session extension isolation.

## Implementation Plan

### 1. Change `PiSessionWorkspace` service ownership

Remove the process-wide cached `servicesPromise` as the source of
`AgentSessionServices` for all loaded sessions.

Replace it with a narrower package setup promise, for example:

```ts
private requiredPackagesPromise?: Promise<void>;
```

Behavior:

- The promise calls `ensureRequiredPiPackages(this.agentDir)` once per process.
- If package setup fails, reset the promise so later session creation can retry.
- Log added packages the same way the current `createServices()` path does.
- The constructor may prewarm package setup only, but must not create shared Pi
  SDK services or load extensions globally.

Add a controller service factory that creates fresh services per controller:

```ts
private async createSessionServices() {
  await this.ensureRequiredPackages();
  return createAgentSessionServices({
    cwd: this.options.cwd,
    agentDir: this.agentDir,
    authStorage: this.authStorage,
    modelRegistry: this.modelRegistry,
  });
}
```

Pass this factory into `PiSessionController.create()` and
`PiSessionController.open()` instead of `getServices: () => this.getServices()`.

### 2. Change `PiSessionController` initialization

Rename the constructor option from `getServices` to a more explicit
`createServices` or `createSessionServices`.

Inside each controller, add a private cached promise:

```ts
private servicesPromise?: Promise<AgentSessionServices>;
```

Controller behavior:

- `getServices()` creates services by calling the injected factory.
- The promise is cached only for that controller.
- On failure, clear the promise so another initialization attempt can retry.
- `initializeSession()` still calls `createAgentSessionFromServices()`, but the
  services it passes must be controller-local.

This keeps concurrent calls to one controller safe without sharing extension
runtime across controllers.

### 3. Make controller dispose extension-aware

Update `PiSessionController.dispose()` so it performs extension shutdown before
SDK disposal when a session exists.

Desired behavior:

1. Cancel pending browser UI prompts.
2. Unsubscribe Agentaz's session event listener.
3. If an SDK session exists, emit `session_shutdown` through its extension
   runner before calling `session.dispose()`.
4. Always call `session.dispose()` once, even if `session_shutdown` handlers
   throw through the SDK error listener.
5. Clear controller references after disposal.

The SDK's `ExtensionRunner.emit()` catches individual extension handler errors,
so calling:

```ts
await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
});
```

is sufficient for normal cleanup. Do not import private SDK internals. If the
public `extensionRunner` type is not exposed cleanly, keep the call typed
through the available SDK session type rather than reaching into dist paths.

`dispose()` should be idempotent enough for current callers: a second call
should not throw just because the controller was already cleaned up.

### 4. Handle partial initialization failure

`initializeSession()` currently assigns `this.sessionResult` before
`bindExtensions()`. If `bindExtensions()` or later subscription setup fails, the
controller can retain a partially initialized session.

Add cleanup around initialization:

- Use a local `sessionResult` variable until bind/subscription setup succeeds,
  or
- In a `catch`, emit `session_shutdown` if extensions were bound, dispose the
  partial session, clear `sessionResult`, clear `uiContext`, clear
  `unsubscribe`, and rethrow.

The implementation does not need a complex state machine, but it must not leave
a permission-system forwarding timer running after failed initialization.

### 5. Keep workspace call sites unchanged behaviorally

The following flows should continue to call controller disposal and should not
duplicate extension shutdown logic:

- session eviction at max loaded capacity
- soft delete of a loaded session
- revert, which disposes and reopens the same session file
- process-level `disposeAll()`

If any of these flows currently assume `dispose()` is synchronous except for its
signature, keep them awaiting it as they already do.

### 6. Update documentation

Update `docs/backend.md`:

- Replace the claim that the workspace creates Pi SDK services once and reuses
  them across loaded sessions.
- Document that the workspace shares auth/model registry and owns the working
  set, while each loaded controller owns isolated Pi SDK services/resource
  loader/extension runtime.
- Mention that this avoids stale extension contexts when one loaded session is
  disposed.

Update `docs/implementation/session-performance.md`:

- Mark the previous process-wide SDK services reuse as a performance
  optimization that was found unsafe with current extension runtime lifecycle.
- Record the new baseline: session creation/opening may again pay extension
  loading cost per loaded session.
- Add guidance that future optimization must preserve per-session extension
  runtime isolation or require SDK/upstream changes.

## Test Plan

Minimum automated verification after code edits:

```bash
pnpm typecheck
pnpm lint
```

Do not run `pnpm build` by default. Do not run `pnpm dev`; if manual smoke
testing needs a server, ask the user to run it.

Recommended targeted SDK-level regression script:

```bash
cd apps/web
node --input-type=module <<'NODE'
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";

const root = join(tmpdir(), `agentaz-isolation-${process.pid}`);
const cwd = join(root, "workspace");
const agentDir = process.env.PI_CODING_AGENT_DIR || join(root, "agent");
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));

const createOne = async () => {
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
  });
  const manager = SessionManager.create(cwd);
  manager.newSession();
  return createAgentSessionFromServices({ services, sessionManager: manager });
};

const first = await createOne();
const second = await createOne();
const errors = [];

await first.session.bindExtensions({ onError: (error) => errors.push(error) });
await second.session.bindExtensions({ onError: (error) => errors.push(error) });

first.session.dispose();
await second.session.extensionRunner.emitBeforeAgentStart(
  "test",
  undefined,
  "system",
  undefined,
);

console.log(JSON.stringify({ errors }, null, 2));
rmSync(root, { recursive: true, force: true });
NODE
```

This script should not report a stale ctx error when each session uses its own
services. It is not a replacement for Agentaz tests because it does not call the
controller dispose path.

Recommended Agentaz behavior checks:

- Load/create two sessions, dispose or delete one idle session, then send a
  prompt to the other. No stale ctx extension error should be logged.
- Trigger max-loaded-session eviction, then continue prompting a remaining
  loaded session. No stale ctx extension error should be logged.
- Revert a loaded persisted session, then prompt the reopened session. No stale
  ctx extension error should be logged.
- Dispose a UI-bound session and wait longer than the permission forwarding poll
  interval. No repeated unhandled stale ctx rejection should be logged.
- Permission approvals should still appear in the browser approval path for
  dangerous tool calls.

## Acceptance Criteria

- `PiSessionWorkspace` no longer hands the same `AgentSessionServices` instance
  to multiple loaded sessions.
- Every initialized `PiSessionController` has an isolated resource loader and
  extension runtime.
- Controller disposal emits extension `session_shutdown` before SDK disposal.
- Disposing one loaded session does not make another loaded session's
  permission-system extension stale.
- The previously observed `[unhandledRejection] stale ctx` loop is gone in the
  dispose/eviction/revert paths.
- `deno task check` and `deno task test` pass.

## Implementation Prompt For Another Agent

Historical prompt used when handing the implementation to another coding agent:

```txt
You are working in /home/zxning/code/Agentaz. Read AGENTS.md first and obey it.

Implement the plan in docs/implementation/pi-extension-runtime-isolation.md.

Goal: fix recurring Pi extension stale context errors by giving each loaded
PiSessionController its own Pi SDK AgentSessionServices/resourceLoader/extension
runtime, while keeping AuthStorage and ModelRegistry shared at the workspace
level. Also make controller disposal emit extension session_shutdown before
calling session.dispose().

Important constraints:
- Do not remove @gotgenes/pi-permission-system.
- Do not change HTTP/SSE protocol types unless you discover an unavoidable need.
- Do not change frontend behavior.
- Do not run pnpm dev or pnpm build by default.
- Do not overwrite unrelated working-tree changes.
- Use apply_patch for manual edits.

Expected code shape:
- In apps/web/server/utils/pi-session-workspace.ts, remove the process-wide
  AgentSessionServices cache as the source used by controllers. Replace it with
  package setup only, and pass a per-controller service factory into
  PiSessionController.create/open.
- In apps/web/server/utils/pi-session-controller.ts, make services caching local
  to one controller, create SDK sessions from those local services, and make
  dispose emit session_shutdown before SDK dispose.
- Add cleanup for partial initializeSession failures so no extension timer or
  stale session remains after bindExtensions/subscription setup fails.
- Update docs/backend.md and docs/implementation/session-performance.md to
  reflect per-loaded-session SDK service isolation and the performance tradeoff.

After edits, run:
pnpm typecheck
pnpm lint

Report exactly what changed and whether both checks passed. If a check fails,
include the relevant failure details and do not hide unrelated pre-existing
working-tree changes.
```
