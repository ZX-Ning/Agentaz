BASED ON HEAD: 0e1f142cd9da8997814ca908a2c8b797096bd360

Reviewr: Claude Opus 4.6

# Overall Architecture review

## What the Architecture Gets Right

**The service graph is well-factored.** Five singletons, each with a clear single responsibility, wired together in a dependency-ordered graph (`AgentRuntime`). The ownership boundaries are sharp: `PiSessionWorkspace` never touches WebSockets, `WsAgentHub` never touches Pi sessions, `ClientPresence` is transport-agnostic. This is exactly the right granularity for a system this size. You could replace the WebSocket transport or the Pi SDK independently without cascading changes.

**HTTP for mutations, WebSocket for events.** This is a genuinely good protocol design choice that many projects get wrong. It gives you free request/response semantics (status codes, headers, body parsing) for actions, idempotency potential, and standard middleware (auth, validation). The WebSocket stays simple: one-way broadcast, no request routing, no correlation IDs. The 15-second heartbeat snapshot as a consistency safety net is pragmatic.

**The fire-and-forget message pattern with re-entrant leases.** The way `messages.post.ts` acquires a control lease, returns 202 immediately, and releases the lease in an `onSettled` callback after the Pi SDK finishes -- with the hold-count supporting overlapping operations from the same client -- is a genuinely well-thought-out concurrency model for a single-threaded environment. It solves the "don't block the HTTP response on a multi-minute agent turn" problem without introducing background job infrastructure.

**Lazy initialization with promise dedup** throughout `PiSessionController` and `PiSessionWorkspace` is correct and handles all the edge cases: concurrent callers share one promise, failure resets the promise so the next caller retries. This is a pattern I'd recommend to other projects.


## Where the Architecture Has Tension

### The "God Composable" Problem

`useAgentaz.ts` at ~1000 lines is the entire frontend brain. It owns WebSocket lifecycle, routing, session management, transcript state, model state, UI requests, API calls, draft session materialization, and error handling. It works today because the app has one page and one user flow, but it is the single most likely place where future feature work will create merge conflicts, unintended side effects, and cognitive overload.

The composable is not decomposable by simply extracting sub-composables, because the state is deeply interconnected: draft session materialization depends on model state, which depends on WebSocket events, which update transcripts, which affect routing. You would need to think carefully about a shared reactive store layer (not necessarily Pinia -- even a set of `provide/inject`-scoped refs) that sub-composables read from and write to independently.

This is not a problem to fix right now, but it is the first structural constraint you will hit when adding features.

### The Transcript Is In Two Places

The backend builds a transcript projection in `PiSessionController` (`transcript` Map, `toolBlocks` Map, streaming delta assembly), and the frontend builds a parallel transcript from WebSocket events (`messagesBySessionId`, `upsertMessage`, `appendMessageBlockDelta`). These two projections can diverge: the backend's projection is authoritative (built from Pi SDK events), while the frontend's is eventually-consistent (built from WebSocket broadcasts that could be missed or arrive out of order).

The `GET /api/agent/sessions/:id/history` endpoint serves the backend's authoritative view, but it is only fetched once on initial load. After that, the frontend relies entirely on the WebSocket stream. If a delta is missed (browser tab backgrounded, WebSocket backpressure), the frontend transcript silently falls behind with no mechanism to detect or repair the divergence.

The 15-second heartbeat sends `state_snapshot` (session metadata), not transcript deltas, so it does not help here.

This is the most subtle architectural gap. A production system would need either: (a) sequence numbers on transcript events so the frontend can detect gaps and re-fetch, or (b) periodic transcript checksums that trigger reconciliation.

### The Event Bus Is Untyped at the Routing Level

`AgentEventBus` carries a discriminated union (`AgentRuntimeEvent`), which is good. But `ServerEvent` -- the payload inside `server_event` -- is a large union of ~15 event types, and `WsAgentHub` broadcasts every `server_event` to every connected peer regardless of which session the event belongs to.

For a single-user app with 1-2 tabs, this is fine. But the design means every browser tab receives transcript deltas for every loaded session, not just the one it is viewing. The frontend silently stores these in `messagesBySessionId[sessionId]` even if the user is not looking at that session. This is actually useful (pre-loads transcript for instant session switching), but it is an implicit design decision that could become a bandwidth concern with many sessions or fast-streaming models.

If you ever need session-scoped event delivery, the hub would need a subscriber-interest registry (which sessions each client is subscribed to). The current architecture does not accommodate this without restructuring.

### The Draft Session Concept Lives Entirely in the Frontend

Draft sessions (prefixed `draft-session-`) are client-side-only constructs. The backend has no awareness of them. When the user sends a message, the frontend "materializes" the draft by POST-ing to `/api/agent/sessions`, then immediately sends the message.

This works but creates a two-step operation that is not atomic: if the session creation succeeds but the message POST fails, you have an empty session on the server and a confused frontend. The `materializeDraftSession` function in `useAgentaz.ts` is already 40+ lines of careful sequencing to handle this.

An alternative design would push session creation into the message endpoint itself: "if no session exists, create one and send the message in a single server operation." This would eliminate the race, simplify the frontend, and move business logic to the server where it is easier to test.

### Eviction Is Best-Effort, Not Guaranteed

Session eviction in `PiSessionWorkspace.releaseOneAvailableSessionIfAtCapacity()` protects sessions that are focused or busy. In a scenario where all 5 loaded sessions are either focused or busy, eviction fails silently and `assertCanLoadAnotherSession()` throws, returning a 409 to the user.

This is technically correct, but the user experience is opaque: "Cannot load another session" with no indication of which sessions are blocking the limit and what to do about it. The surface area for this is small (single user, 5 slots), but the error recovery path is nonexistent.

---

## Design Decisions I Would Validate

**SSR disabled (`ssr: false`).** For a local-first tool, this is fine -- there is no SEO or first-paint concern. But it means the auth middleware runs client-side, and every route change hits `refreshUserSession()` before rendering. If SSR were enabled, auth could be validated server-side before the page even sends HTML.

**No session persistence beyond Pi SDK files.** All session state is derived from Pi SDK session files on disk plus in-memory projections. There is no application-level database. This is the right call for now -- it keeps the system stateless and the Pi SDK as the single source of truth. But it means you cannot add features like bookmarks, tags, search, or usage metrics without either extending the Pi SDK or adding a lightweight store (SQLite).

**Single-process singleton architecture.** The `AgentRuntime` and all its services are process-scoped singletons. This is correct for a local tool but means horizontal scaling, load balancing, or even running two instances on different ports is architecturally impossible. The AGENTS.md correctly flags this as intentional.

---

## Summary Assessment

The architecture is well-suited to its current scope: a single-user, local-first coding agent UI. The layering is clean, responsibilities are separated, and the protocol design (HTTP mutations + WS events) is sound. The documentation accurately reflects the code, which is rare and valuable.

The two areas I would watch most carefully as the project grows:

1. **Transcript consistency** -- the dual-projection model (server + client) without gap detection is the most likely source of hard-to-debug user-visible bugs.
2. **Frontend state concentration** -- the 1000-line composable will resist decomposition and become the bottleneck for feature velocity.

Neither requires immediate action, but both should inform how you plan the next round of feature work.

Now I have complete context on the entire API and backend. Here is my assessment.

---

# API and Backend Design Commentary

### What Works Well

**The service graph is the best part of this codebase.** The five singletons in `AgentRuntime` have crisp ownership boundaries:

- `AgentEventBus` -- knows nothing about sessions, WebSockets, or presence
- `ClientPresence` -- knows nothing about Pi SDK or transport
- `PiSessionWorkspace` -- knows nothing about browser clients or WebSockets
- `SessionProjector` -- read-only, no side effects, no state of its own
- `WsAgentHub` -- knows nothing about Pi SDK internals

Each service can be understood, tested, and replaced in isolation. The dependency graph is acyclic and the initialization order in `getAgentRuntime()` (`agent-runtime.ts:114-144`) makes the wiring explicit. This is better-organized than most projects at this stage.

**The "HTTP for mutations, WebSocket for events" split is fundamentally sound.** Many real-time apps make the mistake of piping everything through the WebSocket, then end up building a request/response protocol on top (correlation IDs, ack messages, error responses). You avoided that entirely. HTTP gives you status codes, content-type negotiation, middleware (auth), and idempotency potential for free. The WebSocket stays dumb: it broadcasts events and has a heartbeat. That's it.

**The fire-and-forget message pattern is well-designed.** In `messages.post.ts:59-75`, the lease is acquired synchronously, `submitMessage` launches the async task without awaiting it, the lease release is passed as an `onSettled` callback that runs in `.finally()`. This means the HTTP response returns immediately while the agent loop runs asynchronously, and the control lease is guaranteed to release even on failure. The re-entrant hold-count in `ClientPresence` (`acquireControl`/`releaseControl`) supports overlapping operations from the same client. This is the correct concurrency model for a single-threaded runtime wrapping a long-running external SDK.

**The thin route pattern is consistent and effective.** Every route file follows the same structure: parse params/body, delegate to workspace/presence/projector via the runtime, wrap in try/catch with `agentHttpError()`. No business logic leaks into routes. The JSDoc on every route file is comprehensive -- HTTP method, request shape, response shape, side effects, error codes. This is a codebase where someone new could read any route file and understand the full contract.

### Where I Have Concerns

**The API surface conflates "session identity" with two different concepts.** A session has both a `sessionId` (Pi SDK's internal ID, used for protocol routing) and a `sessionFile` (the disk path, used for open/dedup). Routes use `sessionId` in the URL path, but `POST /api/agent/sessions` accepts `{ sessionFile }` in the body. `openLoadedSession` in `pi-session-workspace.ts:213-243` deduplicates by normalized file path, not by `sessionId`. Yet the response returns both, and the frontend sometimes stores one, sometimes the other.

This dual-identity creates subtle ambiguity: if a session file is opened, what `sessionId` does it get? The answer is "whatever the Pi SDK's `SessionManager` assigns," which comes from reading the session file. But the frontend receives this only after the POST completes. The draft-session materialization flow in the frontend has to handle the ID transition, and the sidebar merge logic in `agentaz-session-list.ts` has to fuzzy-match by checking `sessionFile`, `file`, *and* `sessionId`. This is the kind of accidental complexity that accumulates around identity confusion.

A cleaner design would pick one canonical identifier (the session file path, since it is the only truly stable identifier across process restarts) and derive all routing from it. The `sessionId` would be an internal implementation detail of the Pi SDK, not exposed in the URL path.

**`readJsonBody` defaulting to `{}` on parse failure is a silent error.** In `agent-http.ts:144`, a malformed JSON body (e.g., truncated, wrong content-type) becomes an empty object. The route then proceeds with all fields undefined. For `messages.post.ts`, this is caught by the `!body.text || !body.mode` check at line 54. But for `response.post.ts`, the body is passed directly to `resolveUiRequest` as a `UiRequestResponseRequest`. Since the discriminated union `{ selected?: string } | { value?: string } | { confirmed: boolean }` is checked with `"confirmed" in response` / `"value" in response`, an empty `{}` would fall through to the `else` branch and call `resolveSelect(requestId, undefined)`. This silently resolves a select prompt with no selection. It would not crash, but it would silently cancel an extension prompt with no feedback to the user about the malformed request.

A stricter approach would return 400 for unparseable bodies on endpoints that require a body.

**`resolveUiRequest` discrimination is fragile.** In `pi-session-workspace.ts:364-381`, the dispatch logic uses `"confirmed" in response` and `"value" in response`. But per the union type in `protocol.ts:523-526`:

```ts
export type UiRequestResponseRequest =
  | { selected?: string }
  | { value?: string }
  | { confirmed: boolean };
```

`selected` and `value` are optional on their respective branches. A body like `{ value: "hello", selected: "option1" }` has both keys present because nothing enforces mutual exclusivity. The `"confirmed" in response` check would fail (correctly), but `"value" in response` would match, and `selected` would be silently ignored. More importantly, if a future engineer adds a field to one branch, the priority ordering of the `if/else if/else` chain determines which resolver wins. The API contract does not enforce that exactly one of these fields is present.

A more robust design would add an explicit `type: "select" | "input" | "confirm"` discriminator field to the request body, matching the `kind` field already present on the `PendingRequest` type in `extension-ui-context.ts:13`.

**The error classification layer is fighting the wrong problem.** `agentHttpError` in `agent-http.ts:163-199` maps error messages to HTTP status codes by substring matching. This is fragile on its own (as noted in the previous review), but the deeper issue is that the workspace and controller layers throw untyped `new Error(message)` for domain-meaningful failures. The entire error classification system exists because the domain layer does not speak HTTP and does not produce structured errors.

The right fix is not better substring matching -- it is typed error classes at the domain layer:

```ts
class SessionNotFoundError extends Error { ... }
class SessionControlConflictError extends Error { ... }
class SessionLimitReachedError extends Error { ... }
```

Then `agentHttpError` becomes a simple instanceof chain, which survives message rewording, i18n, and Pi SDK upgrades.

**The broadcast-everything model in `WsAgentHub` has no session scoping.** In `ws-agent-hub.ts:162-186`, every `server_event` is broadcast to every peer. This means if sessions A and B are both loaded, and session A is streaming, every browser tab -- including one focused on session B -- receives every streaming delta for session A. The frontend stores these in `messagesBySessionId[sessionA]`, which is actually useful (instant history when switching sessions), but it means WebSocket traffic scales with the *total* activity across all loaded sessions, not just the one the user is viewing.

For 5 sessions with one user this is fine. But if a future feature allows background sessions to run autonomously (e.g., batch operations), this design would flood the WebSocket with deltas from sessions the user does not care about. Adding a subscription filter (client declares which sessions it wants events for) would be a non-trivial retrofit because the hub currently has no per-client state beyond the peer reference.

**There is no request validation layer.** Each route manually validates its own fields: `if (!body.text || !body.mode) throw new Error(...)` in `messages.post.ts:54`, `if (!body.provider || !body.id) throw new Error(...)` in `model.put.ts:44`. This is fine for a small API, but it means validation rules are spread across 13 route files with no shared schema. There is no runtime type validation (no zod, no ajv, no valibot). The `readJsonBody<T>` generic provides compile-time type inference but no runtime enforcement -- a caller can send `{ mode: 42, text: null }` and it will pass the TypeScript cast silently.

For a local-first tool where the frontend is the only client, this is acceptable. But if you ever expose this API to third-party clients, tools, or CLI scripts, the lack of schema validation becomes a real risk.

**`PiSessionController` at 1415 lines is the backend equivalent of the "god composable" problem.** It handles: session initialization, message dispatch (prompt/steer/followUp), transcript projection, tool block tracking, model/thinking settings, deferred settings, extension UI context, history normalization, event routing from the Pi SDK, and anonymous tool call ID generation. These are at least 4-5 distinct responsibilities.

The transcript projection logic in particular (the `onSessionEvent` handler with its `tool_call_start`/`tool_call_delta`/`tool_result` mapping, the `toolBlocks` registry, the `currentAssistantMessageId`/`currentTextBlockId`/`currentThinkingBlockId` tracking) is complex enough to deserve its own class. It is the most likely place for bugs when the Pi SDK changes event shapes, and it is currently entangled with session lifecycle methods that have nothing to do with transcript construction.

**The WebSocket upgrade auth cast is a code smell.** In `ws.ts:27`, `requireAgentazAuth(request as any)` casts the upgrade request to `any` because H3's `requireUserSession` expects an `H3Event`, not a WebSocket upgrade request. This works because the underlying implementation reads cookies from the request headers, which are present on both. But it is a runtime assumption that could break if `nuxt-auth-utils` changes how it accesses event properties. An explicit cookie extraction and validation for the WebSocket path would be more robust.

### Design Decisions Worth Acknowledging

**Session eviction is the right trade-off.** Bounding the loaded session set at 5 with LRU-like eviction, protecting focused and busy sessions, is exactly what a local-first tool should do. The alternative (unbounded loading) would eventually exhaust memory. The protection callback via `getProtectedSessionIds` is a clean dependency inversion -- the workspace does not know about presence directly.

**The extension UI bridge (`WebExtensionUIContext`) is genuinely clever.** Translating synchronous-looking Pi extension prompts into WebSocket request/response pairs with timeout fallback is the hardest bridge problem in this codebase, and it is handled well. The `cancelAll()` on abort/disconnect prevents extension code from hanging. The widget rendering with `plainTheme()` is pragmatic. The timeout-to-fallback-value strategy (false for confirm, undefined for select/input) matches the principle of least privilege.

**The deferred settings pattern is correct.** Queuing model/thinking changes while the agent is busy, then applying them atomically when idle via `applyPendingSettingsIfIdle()`, avoids a whole class of race conditions where a model change mid-stream could cause undefined behavior in the Pi SDK. The snapshot-and-clear approach (`const snapshot = { ...this.pendingSettings }; this.pendingSettings = {};`) prevents double-apply.

### Summary

The backend architecture is sound for a single-user local-first tool. The service layering, concurrency model, and protocol design are above average. The main structural debts are:

1. **PiSessionController conflates too many responsibilities** -- transcript projection should be extracted.
2. **No typed error hierarchy** -- substring matching is a ticking maintenance bomb.
3. **No request body validation** -- the API trusts the frontend to send correct shapes.
4. **Dual session identity** (`sessionId` vs `sessionFile`) creates accidental complexity at every integration point.
5. **Broadcast-everything WebSocket** works today but has no path to session-scoped delivery.

None of these require immediate action, but items 1 and 2 will generate the most friction as the codebase grows.
