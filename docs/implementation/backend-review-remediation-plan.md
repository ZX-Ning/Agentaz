# Backend Review Remediation Plan

## Status

- **State:** In progress
- **Created:** 2026-07-19
- **Baseline commit:** `b98e6c8818fc` (`test(api): expand backend coverage`)
- **Scope:** `packages/api`, `packages/protocol`, related frontend
  thinking-level handling, and backend documentation/tests
- **Source:** The current backend code review covering architecture weaknesses,
  B1–B12, code-quality observations, and test gaps

This is a living implementation tracker. Update finding/workstream status in
this file as changes land. Historical review notes, including
[`backend-code-review-2026-07-09.md`](./backend-code-review-2026-07-09.md),
remain separate records and should not be treated as the current backlog.

Status values used below:

- `TODO`: accepted work not started
- `DOING`: implementation or verification in progress
- `BLOCKED`: waiting on a decision or upstream change
- `DONE`: acceptance criteria verified
- `ACCEPTED`: documented risk/design choice; no implementation currently planned

## Baseline And Corrections

The review baseline is healthy:

```text
deno task check   pass
deno lint         pass (64 files)
deno task test    pass (66/66)
```

Independent validation confirmed most findings, with these corrections reflected
in this plan:

1. The capacity/dedup race is reproducible in `openLoadedSession()`. Concurrent
   `createLoadedSession()` calls do not exceed the cap because their final
   capacity assertion and registration are synchronous.
2. Concurrent opens of one file create two controllers and leak/overwrite one in
   the Map. Current HTTP routes do not continue mutating the overwritten
   controller, so immediate JSONL corruption is not proven; duplicate ownership
   is still an invalid and unsafe state.
3. Pi SDK `0.80.6` currently throws plain `Error` instances with fixed compact
   messages. There is no typed upstream compact-unavailable error yet.
4. Pi SDK `0.80.6` supports thinking level `max`. Agentaz omits it from backend
   and frontend capability lists. A direct live-session API request passes `max`
   to the SDK; dormant-session normalization and the normal UI path are where
   support is lost.
5. Current Pi SDK parallel tool events carry explicit tool-call IDs. Concurrent
   anonymous tool events remain an unsupported legacy/provider edge case.
6. `Dockerfile` already binds the container server to `0.0.0.0`; login hardening
   is therefore relevant whenever the container port is published beyond
   loopback.

The performance investigation also reproduced the quadratic history path:

| Current-branch entries | One uncached `getHistory()` projection |
| ---------------------: | -------------------------------------: |
|                  1,000 |                            about 19 ms |
|                  2,000 |                            about 61 ms |
|                  4,000 |                           about 246 ms |
|                  8,000 |                           about 1.41 s |

These are local diagnostic measurements, not stable CI thresholds.

## Goals

1. Preserve `loadedSessions <= maxLoadedSessions` under all concurrent lifecycle
   requests.
2. Maintain exactly one loaded controller per normalized session file and
   session ID.
3. Keep loaded and persisted state recoverable when revert/delete operations
   fail.
4. Remove avoidable O(n²) and per-client repeated session projections.
5. Harden network-exposed authentication/error paths without changing the
   current single-user product model.
6. Keep protocol and SDK compatibility explicit, especially for thinking levels
   and compact/tool-event adapters.
7. Close the review's concurrency, auth, SSE, request parsing, event dispatch,
   and performance test gaps.

## Invariants And Non-Goals

Preserve these existing invariants while fixing the findings:

- Local-first, single-user operation remains the product model.
- `deno task serve` continues to bind to `127.0.0.1` by default.
- SSE detach does not abort or dispose loaded Pi sessions.
- Browser actions use HTTP; SSE remains server-to-browser realtime delivery.
- Each initialized controller owns an isolated Pi extension runtime.
- Dangerous tool approvals continue through the web permission-system path.
- `transcriptRevision` remains monotonic for a session across controller
  replacement.

Out of scope for this plan:

- Multi-user identities or authorization
- Database persistence or a server-side session revocation database
- Project/cwd switching
- Replacing the Pi permission-system integration
- Full Pi tree navigation or message/part storage redesign

## Finding Register

| ID            | Review item                                           | Disposition                           | Priority | Workstream | Status |
| ------------- | ----------------------------------------------------- | ------------------------------------- | -------- | ---------- | ------ |
| `COR-01`      | B1: loaded-session open/capacity/dedup race           | Fix                                   | P0       | WS1        | DONE   |
| `COR-02`      | B3: revert/delete failure atomicity                   | Fix                                   | P1       | WS2        | DONE   |
| `PERF-01`     | Snapshot/usage projection repeated per client         | Fix                                   | P2       | WS5        | TODO   |
| `PERF-02`     | `getHistory()` branch lookup is O(n²)                 | Fix                                   | P1       | WS5        | TODO   |
| `COORD-01`    | B2: client ID can be forged                           | Document coordination-only boundary   | P2       | WS3        | TODO   |
| `SDK-01`      | B4: compact classification depends on SDK text        | Isolate adapter + track upstream      | P2       | WS4        | TODO   |
| `HTTP-01`     | B5: route parameters are decoded twice                | Fix                                   | P3       | WS3        | TODO   |
| `MEM-01`      | B6: history revision retention is unbounded           | Fix without weakening monotonicity    | P3       | WS6        | TODO   |
| `EVENT-01`    | B7: overlapping anonymous tool calls cross-wire       | Guard unsupported edge case           | P3       | WS4        | TODO   |
| `AUTH-01`     | B8: login has no rate limiting                        | Fix                                   | P1       | WS3        | TODO   |
| `AUTH-02`     | B9: copied stateless token survives logout            | Explicitly accept for local mode      | P3       | WS3        | TODO   |
| `HTTP-02`     | B10: unknown 500 messages expose internals            | Fix + server-side logging             | P2       | WS3        | TODO   |
| `PROTO-01`    | B11: merged assistant metadata semantics are implicit | Document intentional projection       | P3       | WS4        | TODO   |
| `COMPAT-01`   | B12: `max` thinking support is incomplete             | Fix across protocol/backend/frontend  | P1       | WS4        | TODO   |
| `CLEAN-01`    | B12: required packages use `process.env`              | Standardize on `Deno.env`             | P4       | WS6        | TODO   |
| `MODEL-01`    | B12: dormant model context read can throw             | Make failure behavior explicit/tested | P3       | WS6        | TODO   |
| `STATIC-01`   | B12: SPA fallback rereads `index.html`                | Cache production shell read           | P4       | WS5        | TODO   |
| `AUTH-03`     | B12: public auth path matching is brittle             | Use exact normalized paths            | P3       | WS3        | TODO   |
| `STYLE-01`    | Truncation markers use inconsistent ellipses          | Standardize                           | P4       | WS6        | TODO   |
| `REFACTOR-01` | Controller normalization helpers make file oversized  | Extract after behavior fixes          | P4       | WS6        | TODO   |

`AUTH-02` is tracked even though the expected outcome is an accepted risk. It is
not complete until the logout/revocation semantics and remote-exposure gate are
explicitly documented.

## Workstreams

### WS1 — Serialize Workspace Lifecycle Mutations

**Priority:** P0\
**Findings:** `COR-01`\
**Depends on:** none

The workspace needs one serialization boundary around operations that inspect
and mutate loaded/persisted session ownership. A promise-chain mutex is
sufficient; these operations are infrequent and already perform filesystem/SDK
work.

#### Tasks

- [x] Add a failure-safe workspace lifecycle queue/mutex. A rejected operation
      must not poison later queue entries.
- [x] Serialize create, open, fork, revert, rename, soft-delete, eviction, and
      `disposeAll` ownership transitions.
- [x] Keep message turns and ordinary controller operations outside this mutex.
- [x] Split public locking methods from private `...WithinMutation` helpers so
      `forkSession()`/`revertSession()` can open a controller without
      recursively acquiring a non-reentrant lock.
- [x] Perform normalized-path deduplication again inside the serialized
      transaction, after all asynchronous validation.
- [x] Keep eviction, final capacity assertion, controller creation/open, and Map
      registration in the same transaction.
- [x] Dispose any controller created but not registered because of an error or a
      defensive late duplicate check.
- [x] Preserve protected/busy-session eviction rules and existing
      `session_removed`/`state_changed` ordering.
- [x] Add focused concurrency tests before or with the implementation.

#### Required Tests

1. Two concurrent opens of different files with `maxLoadedSessions = 1` never
   leave more than one loaded session.
2. Two concurrent opens of the same normalized file return the same controller
   object and invoke `controllerFactory.open` once.
3. Concurrent create/open at capacity performs at most one eligible eviction per
   successful replacement.
4. A failed first queued mutation does not block the second mutation.
5. Protected and busy controllers remain non-evictable under concurrent
   pressure.
6. Concurrent creates retain the existing cap behavior, guarding the finding's
   corrected interpretation.

#### Acceptance Criteria

- `loadedSessions().length` never exceeds the configured cap.
- One normalized persisted file has at most one registered controller.
- No overwritten/unregistered controller remains undisposed.
- Existing eviction, revision seeding, and route tests continue to pass.

### WS2 — Make Revert And Soft-Delete Failure-Atomic

**Priority:** P1\
**Findings:** `COR-02`\
**Depends on:** WS1

Lifecycle serialization prevents competing mutations but does not by itself make
a multi-step disk/controller transition recoverable.

#### Tasks

- [x] Rework revert into a staged replacement:
  1. validate idle/current-branch state;
  2. persist the branch marker;
  3. construct the replacement controller without public open dedup returning
     the old controller;
  4. swap registration only after replacement creation succeeds;
  5. dispose the old controller after the swap.
- [x] If replacement creation fails, keep the original controller registered and
      usable against its now-reverted manager state.
- [x] Preserve monotonic history revision across both success and recovery
      paths.
- [x] Compute/validate the soft-delete destination before unregistering the
      loaded controller.
- [x] Define a commit point for soft-delete. A rename failure before commit must
      leave the loaded controller registered and undisposed.
- [x] If cleanup fails after a successful rename, either roll the rename back or
      reopen/register a replacement before returning an error.
- [x] Publish `session_removed` and refresh persisted state only after the
      operation commits.
- [x] Keep source JSONL data recoverable on every failed path.

#### Required Tests

- Revert replacement factory failure after `branch()`/`appendSessionInfo()`.
- Revert old-controller dispose failure after a replacement is ready.
- Soft-delete destination calculation failure.
- Soft-delete rename failure for a loaded session.
- Soft-delete post-rename cleanup failure and rollback/recovery.
- No removal event is published for an operation that did not commit.

#### Acceptance Criteria

- A failed revert does not make the session disappear from the workspace.
- A failed soft-delete leaves either the original loaded session or a usable
  recovered replacement.
- Success emits one committed removal/state transition, not intermediate states.

### WS3 — Harden HTTP, Authentication, And Exposure Boundaries

**Priority:** P1/P2/P3\
**Findings:** `COORD-01`, `HTTP-01`, `AUTH-01`, `AUTH-02`, `HTTP-02`, `AUTH-03`\
**Depends on:** none

#### Tasks

- [ ] Add bounded process-local login backoff suitable for one admin identity:
  - count consecutive failures;
  - apply capped exponential delay;
  - reset after successful login and after an idle window;
  - do not introduce permanent lockout or database state.
- [ ] Make limiter timing injectable so unit tests do not sleep.
- [ ] Document container exposure explicitly: `Dockerfile` listens on `0.0.0.0`
      inside the container, and host port publishing should default to loopback
      or a trusted network.
- [ ] Add a loud startup/deployment warning for broader network exposure where
      the bind mode is known.
- [ ] State in `docs/backend.md` and client-presence JSDoc that client
      IDs/control leases prevent accidental tab collisions; they are not
      authentication or authorization principals.
- [ ] Do not present simple presence membership validation as a security fix:
      the same authenticated caller can observe/reuse another registered ID. A
      true fix would require an unshared per-tab credential and is outside the
      current threat model.
- [ ] Explicitly document stateless logout semantics: clearing the browser
      cookie does not revoke a copied token before its 24-hour expiry.
- [ ] Treat server-side revocation as a prerequisite decision if remote or
      multi-user operation is introduced later, not as a database addition in
      this plan.
- [ ] Remove the second `decodeURIComponent()` from `requireRouteParam()` and
      test encoded percent/malformed escape inputs.
- [ ] Match public auth routes by exact normalized path instead of
      `includes`/`endsWith` checks.
- [ ] Return a generic message for unexpected `500 agent_error` responses.
- [ ] Log the original unexpected error server-side exactly once with useful
      route context; preserve typed domain/HTTP error messages.
- [ ] Update tests that currently pin raw unknown error messages.

#### Required Auth Tests

- Correct and incorrect admin password verification.
- Missing password hash and secret shorter than 32 characters.
- Process-local secret generation when no secret is configured.
- Valid, expired, malformed, wrong-secret, and wrong-salt tokens.
- Login backoff progression, cap, reset, and idle expiry using a fake
  clock/delay.
- Logout clears the current cookie while a copied original token demonstrates
  the documented stateless behavior.
- Exact public route behavior, including trailing slash decisions.

#### Acceptance Criteria

- Repeated login failures incur a bounded delay without blocking the process
  indefinitely.
- Unexpected filesystem/SDK details no longer cross the HTTP boundary.
- Unexpected errors remain visible in local server logs.
- Normal UUID route parameters are unchanged; double-encoded and malformed
  inputs cannot become a second decoded path value or an accidental 500.
- No authentication, user-account, or database concepts are added.

### WS4 — Align SDK, Event, And Protocol Compatibility

**Priority:** P1/P2/P3\
**Findings:** `SDK-01`, `EVENT-01`, `PROTO-01`, `COMPAT-01`\
**Depends on:** none

Frontend edits in this workstream must follow `docs/frontend.md`.

#### Tasks

- [ ] Add `max` to backend default thinking levels and frontend thinking
      options.
- [ ] Match Pi SDK capability rules: both `xhigh` and `max` require an explicit
      non-null model mapping before they are advertised.
- [ ] Preserve/restore persisted `max` instead of normalizing it to `off`.
- [ ] Ensure draft model selection, live model state, frontend validation, and
      closest-level fallback all understand the same ordered level set.
- [ ] Add protocol/backend/frontend table-driven tests for every thinking level.
- [ ] Extract compact-unavailable recognition into a small SDK-adapter helper
      with exact tests and a comment naming the pinned SDK behavior.
- [ ] Record an upstream Pi SDK issue/link requesting a typed
      compact-unavailable error; replace text matching when such a type becomes
      available.
- [ ] Keep unknown compact errors as 500-class failures.
- [ ] Document that current SDK tool events must carry explicit IDs for parallel
      execution.
- [ ] Detect overlapping anonymous tool starts. Once correlation becomes
      ambiguous, stop projecting anonymous update/end events for that turn,
      log/emit a recoverable projection error, and rely on authoritative
      persisted history after completion rather than cross-wiring blocks.
- [ ] Preserve the existing sequential anonymous fallback.
- [ ] Clarify `UiMessage.entryId`/`rewindEntryId` comments: one browser
      assistant message may aggregate multiple consecutive Pi assistant entries
      and retains the first message's metadata.
- [ ] Keep the current UI action boundary: rewind/fork actions target user
      messages, not an unrepresented midpoint inside an assistant turn.

#### Required Tests

- A model with explicit `max` mapping advertises/selects/restores `max`.
- A reasoning model without explicit `max` mapping does not advertise it.
- Dormant and initialized model state agree on `max`.
- Known compact messages map to `409 context_compact_unavailable`;
  changed/unknown messages remain 500 until the upstream contract changes.
- Two overlapping anonymous starts cannot update or complete each other's
  blocks.
- `queue_update` and `compaction_end` are exercised through `onSessionEvent()`,
  not only through direct helper calls.
- Merged assistant metadata behavior is pinned by a normalization test.

#### Acceptance Criteria

- The protocol, backend, frontend, and SDK adapter expose one consistent
  thinking level set.
- Parallel current-SDK tools remain unchanged.
- Unsupported anonymous overlap fails visibly without corrupting the live block
  projection.
- No SDK message text is classified in the generic HTTP error mapper.

### WS5 — Remove Projection And History Hot Paths

**Priority:** P1/P2/P4\
**Findings:** `PERF-01`, `PERF-02`, `STATIC-01`\
**Depends on:** WS1 for stable lifecycle ownership; otherwise independent

#### Tasks

- [ ] Replace per-message `branchEntries.findIndex()` with one O(n) ID/index
      pass in `getHistory()`.
- [ ] Preserve compaction entries, rewind IDs, tool-result grouping, and
      one-assistant-message-per-turn normalization.
- [ ] Cache usage stats by a stable branch token such as
      `SessionManager.getLeafId()`; do not call `getBranch()` merely to decide
      whether the cache is valid.
- [ ] Invalidate usage projection after prompt persistence, agent completion,
      compaction, revert/reopen, and any other branch-leaf change.
- [ ] Separate expensive client-independent loaded-session projection from
      client-specific active/control decoration.
- [ ] During one SSE broadcast, compute the shared loaded-session projection
      once, then decorate it for each client.
- [ ] Reuse the initial projection when emitting hello plus the immediately
      following state snapshot.
- [ ] Ensure rename, pending UI, widgets, streaming flags, queue counts, and
      control state are never stale because of caching.
- [ ] Cache the production SPA `index.html` read at app creation/first use while
      preserving startup/read errors and test isolation.
- [ ] Add structural counter tests and a non-flaky large-history
      benchmark/regression test. Prefer operation-count assertions over strict
      wall-clock thresholds in CI.

#### Acceptance Criteria

- Uncached history normalization is O(n) in current-branch entries.
- Repeated snapshots at one unchanged branch leaf compute usage totals once per
  controller, not once per client.
- A branch-changing event invalidates the cache and exposes updated totals.
- Multi-client snapshots retain correct per-client active/control fields.
- Large-history regression coverage would fail if an inner linear lookup is
  reintroduced.

### WS6 — Bound Memory And Finish Low-Risk Cleanup

**Priority:** P3/P4\
**Findings:** `MEM-01`, `CLEAN-01`, `MODEL-01`, `STYLE-01`, `REFACTOR-01`\
**Depends on:** WS1/WS2 before changing revision ownership; behavior tests
before refactoring normalization

#### Tasks

- [ ] Replace unbounded per-session revision retention with a bounded mechanism
      that preserves stale-response protection. Prefer a workspace-wide
      monotonic generation seed over an arbitrary LRU:
  - seed every replacement above all live/remembered controller revisions;
  - advance the generation before eviction/disposal;
  - keep only O(1) workspace revision state.
- [ ] Add tests covering eviction/reopen/revert after many distinct sessions and
      prove the replacement revision remains greater than the previous instance.
- [ ] Replace `process.env[AGENTAZ_PI_NODE_MODULES_DIR]` with `Deno.env.get()`
      for repository consistency; retain current behavior/tests.
- [ ] Keep dormant `buildSessionContext()` failures explicit rather than
      silently reporting `off`/no model. Rely on the hardened generic 500
      boundary, add contextual server logging, and test the chosen failure
      contract.
- [ ] Standardize truncation markers (`…` or `...`) in one focused change and
      update exact-output tests.
- [ ] After correctness/protocol changes settle, extract pure
      history/content/tool normalization helpers from `session-controller.ts`
      into a focused module.
- [ ] Move tests with the extracted helpers; do not mix behavioral changes into
      the extraction commit.

#### Acceptance Criteria

- Revision bookkeeping cannot grow with the number of sessions opened during the
  process lifetime.
- Reopened/reverted sessions still reject stale earlier history responses.
- Environment behavior is unchanged.
- Model-context corruption produces a logged generic server failure, not
  fabricated model state or leaked internals.
- Normalization extraction produces no protocol/runtime behavior changes.

### WS7 — Complete Cross-Cutting Coverage

**Priority:** Continuous\
**Findings:** all six reported test gaps\
**Depends on:** tests should land with their owning workstream where practical

| Test gap                               | Owning workstream | Required outcome                                                                   | Status |
| -------------------------------------- | ----------------- | ---------------------------------------------------------------------------------- | ------ |
| Concurrent capacity and same-file open | WS1               | Deterministic race tests fail on baseline and pass after serialization             | TODO   |
| Auth crypto/config edge cases          | WS3               | Direct unit coverage beyond happy-path smoke tests                                 | TODO   |
| Real SSE HTTP stream                   | WS7               | Authenticated hello/snapshot parsing and disconnect cleanup through Hono streaming | TODO   |
| `readJsonBody` empty boundaries        | WS3/WS7           | `content-length: 0`, bodyless request, `Unexpected end`, malformed JSON            | TODO   |
| `onSessionEvent` dispatch branches     | WS4               | Direct `queue_update`, `compaction_end`, metadata/error isolation coverage         | TODO   |
| Large-history/projection regression    | WS5               | Structural complexity/cache assertions plus diagnostic benchmark                   | TODO   |

The SSE integration test should use an in-process server and a controlled
runtime, not a separately started development server. It must cleanly cancel the
response body and assert presence/heartbeat cleanup without leaking timers.

## Delivery Order

### Milestone M0 — Concurrency Correctness

- WS1 complete
- `COR-01` marked `DONE`
- Concurrency tests merged with the fix

### Milestone M1 — Failure Recovery And Exposure Hardening

- WS2 complete
- WS3 login limiting, error redaction/logging, route decoding, and exact auth
  paths complete
- B2/B9 threat-model documentation complete

WS2 depends on M0. WS3 can proceed in parallel in a separate change set.

### Milestone M2 — Protocol And SDK Compatibility

- WS4 complete
- `max` available only where the SDK/model supports it
- compact/anonymous-tool contracts isolated and tested

### Milestone M3 — Performance

- O(n) history projection
- usage/shared snapshot caching
- SPA shell caching
- performance regression coverage

### Milestone M4 — Cleanup

- bounded revision generation
- environment/truncation consistency
- normalization module extraction
- remaining auth/SSE/request/event coverage complete

## Suggested Change Sets

Keep reviews and rollback boundaries small:

1. Workspace race reproductions + lifecycle serialization
2. Revert/soft-delete failure recovery tests + implementation
3. Thinking `max` compatibility across protocol/backend/frontend
4. Login limiter + auth unit tests
5. Route decoding/auth path cleanup + generic 500 logging/redaction
6. O(n) history projection + regression test
7. Usage/shared snapshot cache + SSE projector tests
8. Real SSE HTTP integration and request-body edge tests
9. Bounded revision generation
10. Pure normalization extraction and low-risk style cleanup

Do not combine the normalization file split with concurrency, revision, or
protocol behavior changes.

## Verification Gates

Run after each backend change set from the repository root:

```bash
deno fmt <changed-files>
deno lint <changed-files>
deno task check
deno task test
```

For frontend thinking-level edits, `deno task check` includes the required
frontend typecheck. Do not run `deno task build:web-ui` by default; reserve it
for requested or build/packaging changes.

Additional milestone gates:

- **M0:** deterministic concurrency suite repeated enough to expose scheduling
  bugs
- **M1:** injected filesystem/controller failures leave workspace state
  recoverable
- **M2:** table-driven thinking levels across backend and frontend utilities
- **M3:** structural O(n) history test and cache invocation-count tests
- **M4:** full 66-test baseline plus all newly added tests; no leaked
  timers/resources

Update `docs/backend.md` when lifecycle, auth, error, projection caching, or
accepted security semantics change. Update `docs/frontend.md` and protocol
comments when `max`/assistant metadata handling changes. Update `docs/plan.md`
only if a product or threat-model decision changes.

## Completion Definition

The remediation plan is complete when:

- Every finding in the register is `DONE` or explicitly `ACCEPTED` with
  rationale.
- P0/P1 work and associated failure/concurrency tests are complete.
- No loaded-session cap/dedup invariant can be violated by concurrent HTTP
  requests.
- Failed revert/delete operations leave a usable recovery path.
- Unknown 500s are generic to the client and detailed in server logs.
- `max` thinking behavior is consistent across all layers.
- History/snapshot hot paths have regression coverage.
- All required verification commands pass.

## Progress Log

| Date       | Change                                                                      | Findings                 |
| ---------- | --------------------------------------------------------------------------- | ------------------------ |
| 2026-07-19 | Made revert and loaded soft-delete failure-atomic with recovery tests       | `COR-02` `DONE`          |
| 2026-07-19 | Serialized workspace lifecycle ownership and added deterministic race tests | `COR-01` `DONE`          |
| 2026-07-19 | Created plan from the verified current backend review; no fixes implemented | All registered as `TODO` |
