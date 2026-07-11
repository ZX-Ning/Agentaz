# Backend Code Review — `packages/api`

**Date:** 2026-07-09 **Commit reviewed:** `5a375c9` — "test(api): cover session
normalization and workspace lifecycle" (ZX-Ning, 2026-07-09 21:39:45 +0800)
**Full SHA:** `5a375c910927a7d46ecbcd7e540da43468b69423` **Scope:**
`packages/api/src/**` (+ `packages/protocol/mod.ts` as the shared contract).
Frontend excluded by request. **Reviewer stance:** local-first, single-user
admin app on top of pi-sdk. Findings are weighted against that threat model —
many "security" issues are low-impact because the authenticated user already has
an agent with a `bash` tool. Where that changes the severity, it's called out.

---

## 1. Overall assessment

The backend is well-structured and unusually well-commented. The layering is
clean and the ownership boundaries are explicit:

```
main.ts (assembly)
  └─ agent-runtime (singleton graph: eventBus → presence → workspace → hub)
       ├─ event-bus            in-proc pub/sub, failure-isolated
       ├─ client-presence      focus + re-entrant control leases
       ├─ session-workspace    loaded-session working set, eviction, persistence
       │    └─ session-controller  one Pi session: transcript projection, queues, model state
       │         └─ ui-context      Pi extension UI bridge → SSE
       └─ sse-hub              SSE fan-out + 15s heartbeat
routes/  → http/ helpers → workspace
auth/    → stateless encrypted-cookie admin auth
```

Strengths worth preserving:

- **Per-controller service isolation** (`createSessionServices` per controller,
  not shared) — the comments explain this prevents stale extension-context
  errors. Good call.
- **SSE detach ≠ session dispose** is respected consistently; the lifecycle
  invariants in `AGENTS.md` hold in the code.
- **Failure isolation** in `AgentEventBus.publish`, `SseAgentHub.pushSafely`,
  and the background settlement chain in `submitMessage` — one broken transport
  can't crash a workflow.
- **Domain errors** (`AgentazDomainError`) carry status/code/recoverable and are
  mapped centrally. Clean.
- **Idempotent, non-destructive config writers** (`ensurePermissionConfig`,
  `ensureRequiredPiPackages`) with atomic temp-file+rename in
  `writePermissionConfigFile`.

The issues below are mostly robustness / consistency / defense-in-depth, not
architectural defects.

---

## 2. Bugs & correctness

### 2.1 Unhandled promise rejection in deferred settings apply — **Medium**

`applyPendingSettingsIfIdle()` awaits `session.setModel(model)` with **no
internal try/catch**, and both call sites fire it as `void`:

- `session-controller.ts:1014` (`queue_update`)
- `session-controller.ts:1032` (`agent_end`)

```ts
void this.applyPendingSettingsIfIdle(); // setModel can reject → unhandled rejection
```

If `session.setModel` rejects (e.g. provider/credential error at apply time), it
becomes an unhandled rejection with no user-visible error and no recovery. Every
other `void this.x()` in the controller (`notifySessionMetadataChanged`) wraps
its body in try/catch; this one doesn't.

**Fix:** wrap the body in try/catch and emit a recoverable `error` event, or
attach `.catch()` at both call sites. Also consider: the pending model is
cleared _before_ the await succeeds (`this.pendingSettings = {}` on line 942),
so a failed apply silently drops the user's queued change.

### 2.2 Arbitrary-path session open bypasses workspace-scope validation — **Medium (defense-in-depth)**

`renamePersistedSession` and `softDeletePersistedSession` both funnel through
`requirePersistedSessionFile()`, which validates the path is a member of the
cwd's persisted `.jsonl` list before touching it. `openLoadedSession` does
**not**:

```ts
// session-workspace.ts:335
async openLoadedSession(sessionFile: string) {
    const normalizedSessionFile = resolve(sessionFile);   // only normalizes; no scope check
    ...
    await this.dependencies.controllerFactory.open({ ..., sessionFile: normalizedSessionFile });
}
```

Reachable from `POST /api/agent/sessions` with a body `{ sessionFile }`
(`routes/agent.ts:114`). An authenticated client can ask the server to
`SessionManager.open()` any absolute path on disk. Impact is bounded by the
single-user threat model (the admin already has a `bash` tool), but:

- It's **inconsistent** with the sibling operations that deliberately validate
  scope.
- `SessionManager.open` on a non-session file has undefined behavior (parse
  errors, or partial reads surfaced as "session" data).

**Fix:** route `openLoadedSession` (at least the HTTP-reachable path) through
the same `requirePersistedSessionFile` membership check, or document explicitly
why open is intentionally unscoped while rename/delete are not.

### 2.3 `streamToolResultDelta` assumes monotonically-growing tool output — **Low**

```ts
// session-controller.ts:1246
const delta = fullText.slice(this.toolResultEmittedLength.get(toolCallId)!);
...
this.toolResultEmittedLength.set(toolCallId, fullText.length);
```

This assumes each `partialResult.content` is the previous content plus an
append. If a tool ever emits a _replaced_ (shorter, or rewritten) partial
buffer, the offset math breaks: a shorter `fullText` yields `slice` from a
stale-larger offset → `""` emitted, then `emittedLength` is set to the new
smaller length, and the next growth double-emits already-shown text. The comment
scopes this to the bash tool's accumulate-only behavior, so it's currently safe,
but it's an implicit contract with the SDK that isn't defended. Consider
guarding: only emit when `fullText.length > emitted` and
`fullText.startsWith(previous)`.

### 2.4 Brittle error→status mapping by substring — **Low**

`agentHttpError` (`http/agent.ts:122`) maps _non-domain_ errors to HTTP status
by matching substrings of the message:

```ts
if (message.includes("required")) { statusCode = 400; ... }
else if (message.includes("No loaded session")) { statusCode = 404; ... }
```

Any unrelated 500-class error whose message happens to contain "required" is
silently reported as a client `400 bad_request`, masking real server faults.
Since first-class failures already flow through `AgentazDomainError` (which is
handled correctly above), this fallback mostly catches SDK/Node errors — exactly
the cases where misclassification hurts most. Prefer defaulting unknown errors
to `500` and only special-casing errors you actually throw yourself.

### 2.5 `_rewriteFile` reaches into SDK private state — **Low (fragility)**

```ts
// session-workspace.ts:1013
function forceRewriteSessionFile(sessionManager: SessionManager) {
    (sessionManager as unknown as { _rewriteFile: () => void })._rewriteFile();
}
```

Fork-at-entry depends on a leading-underscore SDK internal to materialize a
user-only branch file. This will break silently on an SDK refactor with no type
error. If the SDK has no public "flush" API, at least add a test that exercises
the entry-scoped fork end-to-end so a regression is caught, and file an upstream
request for a public method.

### 2.6 Minor

- **`submitMessage` is synchronous but `await`ed** at the call sites
  (`routes/agent.ts:265`). Harmless (`await` on a non-promise), but the
  signature reads as if it were async; the `onSettled` release actually fires
  when the _background_ task settles, not when the HTTP call returns. The
  control lease is therefore held for the full agent turn — intended, but
  non-obvious. A one-line comment at the route would help.
- **Unbounded in-memory `transcript` map** per controller
  (`session-controller.ts:175`). It's cleared only implicitly by disposal; a
  very long-lived session accumulates every message. Needed for streaming
  projection, but worth noting as a memory ceiling for marathon sessions.
- **`disposeAll` on `unload`** (`main.ts:103`) is `void`-dispatched; the
  `session_shutdown` extension emit inside `dispose()` may not complete before
  the process exits, so extension timers can be cut off rather than cleanly
  stopped. Acceptable for a local app, but don't rely on it for durable cleanup.

---

## 3. Security

Threat model: one authenticated admin, localhost bind by default. That caps most
impact, but the following are still worth addressing.

### 3.1 Fast, unsalted password hash — **Medium**

```ts
// auth/auth.ts:55
export function hashAdminPassword(password: string) {
    return createHash("sha3-256").update(password, "utf8").digest("base64");
}
```

The admin password is stored (via `AGENTAZ_ADMIN_PASSWORD_HASH`) as a single
unsalted SHA3-256 digest. SHA3 is a _fast_ hash — if the env/hash ever leaks,
offline brute-force is cheap for weak passwords. `timingSafeEqual` with a length
guard on comparison is correct (good), but the hash primitive is the weak link.
Recommend a memory-hard KDF (`scrypt`/`argon2`) with a per-install salt, or at
minimum document that the password must be high-entropy because the stored form
offers no brute-force resistance.

### 3.2 No request-body size limits — **Low/Medium**

`readJsonBody` reads the whole body with no cap, and
`MessageSubmitRequest.images` carries base64 payloads inline. A single large
prompt/image body is loaded fully into memory and JSON-parsed. No
`content-length` ceiling, no streaming guard. On a shared/remote bind (allowed
via env override) this is a trivial memory-pressure vector. Add a max body size
in the middleware (Hono `bodyLimit`).

### 3.3 No rate limiting on login — **Low**

`POST /api/auth/login` has no throttling or lockout. Combined with 3.1, this
makes online guessing feasible if the port is exposed. Localhost-only mitigates
it; add a simple attempt limiter if non-localhost bind is ever a supported mode.

### 3.4 Notes (acceptable as-is, documenting the reasoning)

- **CSRF:** cookie is `httpOnly` + `SameSite=Lax`; mutations are POST/PUT/PATCH
  with JSON. Lax blocks cross-site cookie attachment on top-level cross-site
  POSTs, so this is adequate for the threat model. No CSRF token is fine here,
  but worth a comment so it isn't "fixed" incorrectly later.
- **`secure` cookie flag** is derived from request protocol (`auth/auth.ts:99`).
  Correct for localhost http; if fronted by a TLS-terminating proxy over plain
  http, the cookie won't be marked Secure. Fine given the default bind.
- **Process-local session secret** when `AGENTAZ_SESSION_SECRET` is unset —
  warned loudly, invalidates sessions on restart. Reasonable default.
- **SSE auth is connect-time only.** A stream established before cookie expiry
  stays open indefinitely. Low impact for a single admin; note it if
  session-expiry enforcement ever matters.

---

## 4. Code quality & consistency

- **Excellent comment discipline** — lifecycle phases, invariants, and "who owns
  what" are documented at the boundaries, matching the `AGENTS.md` style
  guidance. This is a real asset; keep it.
- **`app.onError` status cast** (`main.ts:30`):
  `status: httpError.status as 400` is a cast to satisfy Hono's
  `ContentfulStatusCode` typing. It works but hides the real type; a small
  helper that narrows to the known status set would be cleaner than an `as 400`
  lie.
- **Provider-shape normalization is duplicated conceptually** across
  `extractToolCallId`, `extractToolInput`, `normalizeContentPart`, and the event
  handlers — lots of "try camelCase, then snake_case, then nested" probing. It's
  correct and well-tested (`session-controller-normalization.test.ts`), but it's
  the highest-entropy code in the backend and the most likely to drift. It's the
  right place to keep tests dense (it is) and to eventually pin the SDK event
  contract.
- **Naming overlap:** `PiSessionWorkspace.seedHistoryRevision(controller)`
  (private) vs `PiSessionController.seedHistoryRevision(revision)` (public) —
  same name, different arg meaning. Slightly confusing when reading call sites;
  consider `restoreHistoryRevisionFor` on the workspace side.
- **`getModelState` rebuilds `buildSessionContext()` on every call** for
  uninitialized sessions (`session-controller.ts:544`). Cheap today; note it if
  the picker polls.

---

## 5. Testing observations

Good coverage where it matters most (normalization, auth flow, presence,
permission-config validation, workspace lifecycle, server smoke incl. SSE 401).
Gaps I'd prioritize:

1. **Entry-scoped fork** (`createBranchedSession` + `forceRewriteSessionFile`) —
   the private-API dependency (2.5) has no end-to-end guard.
2. **Deferred settings apply failure path** (2.1) — no test forces `setModel` to
   reject after deferral.
3. **`openLoadedSession` scoping** (2.2) — no test asserts what happens with an
   out-of-workspace path.
4. **Control-lease release on background settlement** — `submitMessage`'s
   finally-release chain isn't directly asserted.

---

## 6. Prioritized recommendations

| # | Item                                                                                         | Severity | Effort |
| - | -------------------------------------------------------------------------------------------- | -------- | ------ |
| 1 | Catch rejections in `applyPendingSettingsIfIdle`; don't drop pending change on failure (2.1) | Medium   | S      |
| 2 | Scope-validate `openLoadedSession` like rename/delete, or document the exception (2.2)       | Medium   | S      |
| 3 | Replace SHA3 password hash with a salted KDF; document password-entropy requirement (3.1)    | Medium   | S–M    |
| 4 | Add request body-size limit in middleware (3.2)                                              | Low/Med  | S      |
| 5 | Default unknown errors to 500; stop substring-classifying (2.4)                              | Low      | S      |
| 6 | Guard `streamToolResultDelta` against non-monotonic tool output (2.3)                        | Low      | S      |
| 7 | E2E test for entry-scoped fork; remove/upstream `_rewriteFile` reliance (2.5)                | Low      | M      |
| 8 | Login rate limiting (only if non-localhost bind becomes supported) (3.3)                     | Low      | S      |

Nothing here blocks the current local-first, single-user design. Items 1–3 are
the ones I'd land before broadening the bind or the user model.
