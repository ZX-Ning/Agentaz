import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { AgentEventBus } from "../../src/runtime/event-bus.ts";
import {
    PiSessionWorkspace,
    type PiSessionWorkspaceDependencies,
} from "../../src/pi/session-workspace.ts";
import type { ControllerBase } from "../../src/pi/session-controller.ts";
import {
    PersistedSessionNotFoundError,
    SessionForkUnavailableError,
    SessionLimitReachedError,
} from "../../src/errors.ts";

/**
 * Purpose: Verify the loaded-session cache enforces capacity without disrupting the
 * focused/protected controller and publishes enough state for clients to recover.
 * Expect: The protected session survives, the eligible session is disposed, and removal emits.
 * Method: Insert protected A and evictable B into a two-slot workspace, create C,
 * then inspect insertion order, disposal counts, and the session_removed fallback event.
 */
Deno.test({
    name: "workspace evicts the first idle unprotected session at capacity",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const first = fakeController("session-a");
        const evicted = fakeController("session-b");
        const added = fakeController("session-c");
        const controllers = [first, evicted, added];
        const events: unknown[] = [];
        const eventBus = new AgentEventBus();
        eventBus.subscribe((event) => events.push(event));
        const workspace = createWorkspace(
            eventBus,
            controllers,
            () => ["session-a"],
            2,
        );

        await workspace.createLoadedSession();
        await workspace.createLoadedSession();
        await workspace.createLoadedSession();

        assert.deepEqual(
            workspace.loadedSessions().map((session) => session.sessionId),
            ["session-a", "session-c"],
        );
        assert.equal(stateOf(evicted).disposeCalls, 1);
        assert.equal(stateOf(first).disposeCalls, 0);
        assert.ok(events.some((event) =>
            isRecord(event) &&
            event.type === "session_removed" &&
            event.sessionId === "session-b" &&
            event.fallbackSessionId === "session-a"
        ));
    },
});

/**
 * Purpose: Verify cache pressure cannot interrupt a focused session or an active agent
 * workflow when no safe eviction candidate exists.
 * Expect: Loading past capacity throws and neither protected nor busy controllers are disposed.
 * Method: Fill separate one-slot workspaces with a protected controller and a busy
 * controller, request another session in each, and inspect typed errors/disposal counts.
 */
Deno.test({
    name: "workspace refuses to evict protected or busy sessions",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const protectedController = fakeController("protected");
        const protectedWorkspace = createWorkspace(
            new AgentEventBus(),
            [protectedController, fakeController("next")],
            () => ["protected"],
            1,
        );
        await protectedWorkspace.createLoadedSession();
        await assert.rejects(
            () => protectedWorkspace.createLoadedSession(),
            SessionLimitReachedError,
        );

        const busyController = fakeController("busy", { busy: true });
        const busyWorkspace = createWorkspace(
            new AgentEventBus(),
            [busyController, fakeController("next")],
            () => [],
            1,
        );
        await busyWorkspace.createLoadedSession();
        await assert.rejects(
            () => busyWorkspace.createLoadedSession(),
            SessionLimitReachedError,
        );
        assert.equal(stateOf(protectedController).disposeCalls, 0);
        assert.equal(stateOf(busyController).disposeCalls, 0);
    },
});

/**
 * Purpose: Reproduce concurrent opens that previously crossed the capacity check together.
 * Expect: A one-slot workspace never retains both controllers and disposes one replacement.
 * Method: Pause the first async factory open, enqueue a second file, release the first,
 * then assert serialized registration, final capacity, and single disposal.
 */
Deno.test({
    name:
        "workspace serializes concurrent opens of different files at capacity",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const firstLookupEntered = deferred<void>();
        const releaseFirstLookup = deferred<
            ReturnType<typeof persistedSession>[]
        >();
        const first = fakeController("session-a");
        const second = fakeController("session-b");
        let openCalls = 0;
        let listCalls = 0;
        const workspace = createWorkspace(
            new AgentEventBus(),
            [],
            () => [],
            1,
            () => {
                listCalls += 1;
                if (listCalls === 1) {
                    firstLookupEntered.resolve();
                    return releaseFirstLookup.promise;
                }
                return Promise.resolve([
                    persistedSession("/tmp/session-a.jsonl", "session-a"),
                    persistedSession("/tmp/session-b.jsonl", "session-b"),
                ]);
            },
            (options) => {
                openCalls += 1;
                if (options.sessionFile.endsWith("session-a.jsonl")) {
                    return first;
                }
                return second;
            },
        );

        const openingFirst = workspace.openLoadedSession(
            "/tmp/session-a.jsonl",
        );
        await firstLookupEntered.promise;
        const openingSecond = workspace.openLoadedSession(
            "/tmp/session-b.jsonl",
        );
        releaseFirstLookup.resolve([
            persistedSession("/tmp/session-a.jsonl", "session-a"),
            persistedSession("/tmp/session-b.jsonl", "session-b"),
        ]);
        await Promise.all([openingFirst, openingSecond]);

        assert.equal(openCalls, 2);
        assert.deepEqual(
            workspace.loadedSessions().map((session) => session.sessionId),
            ["session-b"],
        );
        assert.equal(stateOf(first).disposeCalls, 1);
        assert.equal(stateOf(second).disposeCalls, 0);
    },
});

/**
 * Purpose: Prevent two concurrent requests for one normalized file from creating owners.
 * Expect: Both callers receive the same object and the SDK open factory runs once.
 * Method: Pause the first factory call, enqueue the same path through a relative alias,
 * release it, then compare results and factory/disposal counts.
 */
Deno.test({
    name: "workspace deduplicates concurrent opens of one normalized file",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const lookupEntered = deferred<void>();
        const releaseLookup = deferred<ReturnType<typeof persistedSession>[]>();
        const controller = fakeController("session-a");
        let openCalls = 0;
        let listCalls = 0;
        const workspace = createWorkspace(
            new AgentEventBus(),
            [],
            () => [],
            2,
            () => {
                listCalls += 1;
                if (listCalls === 1) {
                    lookupEntered.resolve();
                    return releaseLookup.promise;
                }
                return Promise.resolve([
                    persistedSession("/tmp/session-a.jsonl", "session-a"),
                ]);
            },
            () => {
                openCalls += 1;
                return controller;
            },
        );

        const first = workspace.openLoadedSession("/tmp/session-a.jsonl");
        await lookupEntered.promise;
        const second = workspace.openLoadedSession(
            "/tmp/../tmp/session-a.jsonl",
        );
        await Promise.resolve();
        assert.equal(openCalls, 0);

        releaseLookup.resolve([
            persistedSession("/tmp/session-a.jsonl", "session-a"),
        ]);
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.equal(firstResult, controller);
        assert.equal(secondResult, controller);
        assert.equal(openCalls, 1);
        assert.equal(stateOf(controller).disposeCalls, 0);
    },
});

/**
 * Purpose: Ensure concurrent create/open replacements cannot cause duplicate eviction.
 * Expect: Each successful replacement evicts at most its one predecessor.
 * Method: Fill one slot, enqueue create plus open, then inspect every controller disposal.
 */
Deno.test({
    name: "workspace performs one eviction per concurrent capacity replacement",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const initial = fakeController("initial");
        const created = fakeController("created");
        const opened = fakeController("opened");
        const workspace = createWorkspace(
            new AgentEventBus(),
            [initial, created],
            () => [],
            1,
            () =>
                Promise.resolve([
                    persistedSession("/tmp/opened.jsonl", "opened"),
                ]),
            () => opened,
        );
        await workspace.createLoadedSession();

        await Promise.all([
            workspace.createLoadedSession(),
            workspace.openLoadedSession("/tmp/opened.jsonl"),
        ]);

        assert.equal(stateOf(initial).disposeCalls, 1);
        assert.equal(stateOf(created).disposeCalls, 1);
        assert.equal(stateOf(opened).disposeCalls, 0);
        assert.deepEqual(
            workspace.loadedSessions().map((session) => session.sessionId),
            ["opened"],
        );
    },
});

/**
 * Purpose: Prove a rejected lifecycle transaction cannot poison the mutation queue.
 * Expect: The first open rejects during validation and the second still opens normally.
 * Method: Hold and reject the first persisted-list lookup while a second open waits.
 */
Deno.test({
    name: "workspace lifecycle queue continues after a failed mutation",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const firstLookup = deferred<ReturnType<typeof persistedSession>[]>();
        const controller = fakeController("session-b");
        let listCalls = 0;
        let openCalls = 0;
        const workspace = createWorkspace(
            new AgentEventBus(),
            [],
            () => [],
            1,
            () => {
                listCalls += 1;
                return listCalls === 1 ? firstLookup.promise : Promise.resolve([
                    persistedSession(
                        "/tmp/session-b.jsonl",
                        "session-b",
                    ),
                ]);
            },
            () => {
                openCalls += 1;
                return controller;
            },
        );

        const failed = workspace.openLoadedSession("/tmp/session-a.jsonl");
        await Promise.resolve();
        const succeeded = workspace.openLoadedSession("/tmp/session-b.jsonl");
        firstLookup.reject(new Error("list failed"));

        await assert.rejects(() => failed, /list failed/);
        assert.equal(await succeeded, controller);
        assert.equal(listCalls, 2);
        assert.equal(openCalls, 1);
    },
});

/**
 * Purpose: Keep protected and busy owners non-evictable under queued pressure.
 * Expect: Concurrent create/open requests both fail and the existing owner remains intact.
 * Method: Exercise separate protected and busy one-slot workspaces with two queued loads.
 */
Deno.test({
    name:
        "workspace preserves non-evictable sessions under concurrent pressure",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        for (const mode of ["protected", "busy"] as const) {
            const current = fakeController("current", {
                busy: mode === "busy",
            });
            const workspace = createWorkspace(
                new AgentEventBus(),
                [current, fakeController("unused-create")],
                () => mode === "protected" ? ["current"] : [],
                1,
                () =>
                    Promise.resolve([
                        persistedSession("/tmp/next.jsonl", "next"),
                    ]),
                () => fakeController("unused-open"),
            );
            await workspace.createLoadedSession();

            const results = await Promise.allSettled([
                workspace.createLoadedSession(),
                workspace.openLoadedSession("/tmp/next.jsonl"),
            ]);

            assert.ok(results.every((result) =>
                result.status === "rejected" &&
                result.reason instanceof SessionLimitReachedError
            ));
            assert.equal(stateOf(current).disposeCalls, 0);
            assert.deepEqual(
                workspace.loadedSessions().map((session) => session.sessionId),
                ["current"],
            );
        }
    },
});

/**
 * Purpose: Guard the loaded-session cap while replacements retain their old owner until commit.
 * Expect: All requests settle successfully and the published working set never exceeds the cap.
 * Method: Queue four creates into two slots and record factory-time plus final working-set sizes.
 */
Deno.test({
    name: "workspace retains the loaded-session cap across concurrent creates",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const controllers = [
            fakeController("session-a"),
            fakeController("session-b"),
            fakeController("session-c"),
            fakeController("session-d"),
        ];
        const workspaceRef: { current?: PiSessionWorkspace } = {};
        const factorySizes: number[] = [];
        const workspace = createWorkspace(
            new AgentEventBus(),
            [],
            () => [],
            2,
            undefined,
            undefined,
            () => {
                assert.ok(workspaceRef.current);
                factorySizes.push(
                    workspaceRef.current.loadedSessions().length,
                );
                return requireNextController(controllers);
            },
        );
        workspaceRef.current = workspace;

        await Promise.all([
            workspace.createLoadedSession(),
            workspace.createLoadedSession(),
            workspace.createLoadedSession(),
            workspace.createLoadedSession(),
        ]);

        assert.deepEqual(
            workspace.loadedSessions().map((session) => session.sessionId),
            ["session-c", "session-d"],
        );
        assert.deepEqual(factorySizes, [0, 1, 2, 2]);
        assert.ok(workspace.loadedSessions().length <= 2);
    },
});

/**
 * Purpose: Keep the current owner reachable when replacement construction fails at capacity.
 * Expect: The failed create leaves the old controller registered and undisposed.
 * Method: Fill one slot, throw from the next factory call, then inspect ownership and cleanup.
 */
Deno.test({
    name:
        "workspace preserves the eviction candidate when replacement construction fails",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const current = fakeController("current");
        let createCalls = 0;
        const workspace = createWorkspace(
            new AgentEventBus(),
            [],
            () => [],
            1,
            undefined,
            undefined,
            () => {
                createCalls += 1;
                if (createCalls === 1) {
                    return current;
                }
                throw new Error("replacement construction failed");
            },
        );
        await workspace.createLoadedSession();

        await assert.rejects(
            () => workspace.createLoadedSession(),
            /replacement construction failed/,
        );

        assert.deepEqual(
            workspace.loadedSessions().map((session) => session.sessionId),
            ["current"],
        );
        assert.equal(stateOf(current).disposeCalls, 0);
    },
});

/**
 * Purpose: Keep replacement ownership committed when eviction cleanup fails.
 * Expect: The create rejects with the cleanup error, but the new controller remains loaded.
 * Method: Reject disposal of a reserved candidate after the ownership swap and inspect state.
 */
Deno.test({
    name: "workspace retains the replacement after eviction cleanup fails",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const cleanupError = new Error("eviction cleanup failed");
        const current = fakeController("current", {
            dispose: () => Promise.reject(cleanupError),
        });
        const replacement = fakeController("replacement");
        const workspace = createWorkspace(
            new AgentEventBus(),
            [current, replacement],
            () => [],
            1,
        );
        await workspace.createLoadedSession();

        await assert.rejects(
            () => workspace.createLoadedSession(),
            cleanupError,
        );

        assert.deepEqual(
            workspace.loadedSessions().map((session) => session.sessionId),
            ["replacement"],
        );
        assert.equal(stateOf(current).disposeCalls, 1);
        assert.equal(stateOf(replacement).disposeCalls, 0);
    },
});

/**
 * Purpose: Verify the HTTP-facing workspace contract remains fire-and-forget while
 * metadata refresh and control-lease release stay coupled to actual task settlement.
 * Expect: Acceptance returns immediately; metadata refresh and settlement occur after resolution.
 * Method: Submit a prompt backed by a deferred promise, assert the immediate acceptance
 * payload and zero refreshes, resolve it, then await settlement and inspect refresh/calls.
 */
Deno.test({
    name: "workspace returns prompt acceptance before task settlement",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const prompt = deferred<void>();
        const settled = deferred<void>();
        const controller = fakeController("session-a", {
            prompt: () => prompt.promise,
        });
        let listCalls = 0;
        const workspace = createWorkspace(
            new AgentEventBus(),
            [controller],
            () => [],
            2,
            () => {
                listCalls += 1;
                return Promise.resolve([]);
            },
        );
        await workspace.createLoadedSession();

        const response = workspace.submitMessage(
            "session-a",
            {
                mode: "prompt",
                clientMessageId: "client-1",
                text: "hello",
            },
            () => settled.resolve(),
        );

        assert.equal(response.accepted, true);
        assert.equal(response.clientMessageId, "client-1");
        assert.ok(response.turnId);
        assert.equal(listCalls, 0);

        prompt.resolve();
        await settled.promise;
        assert.equal(listCalls, 1);
        assert.equal(stateOf(controller).promptCalls, 1);
    },
});

/**
 * Purpose: Verify both agent-task and post-task metadata failures are isolated after the
 * HTTP response, while the control lease's settlement callback remains guaranteed.
 * Expect: A recoverable message_failed event emits and settlement runs despite refresh failure.
 * Method: Reject prompt and listPersistedSessions independently, await the settlement
 * callback, drain one microtask, then inspect server events and captured console errors.
 */
Deno.test({
    name: "workspace reports failed messages and always settles control",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        using errors = captureConsoleErrors();
        const settled = deferred<void>();
        const controller = fakeController("session-a", {
            prompt: () => Promise.reject(new Error("model failed")),
        });
        const events: unknown[] = [];
        const eventBus = new AgentEventBus();
        eventBus.subscribe((event) => events.push(event));
        const workspace = createWorkspace(
            eventBus,
            [controller],
            () => [],
            2,
            () => Promise.reject(new Error("refresh failed")),
        );
        await workspace.createLoadedSession();

        workspace.submitMessage(
            "session-a",
            {
                mode: "prompt",
                clientMessageId: "client-1",
                text: "hello",
            },
            () => settled.resolve(),
        );
        await settled.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.ok(events.some((event) =>
            isRecord(event) &&
            event.type === "server_event" &&
            isRecord(event.event) &&
            event.event.type === "error" &&
            event.event.code === "message_failed"
        ));
        assert.equal(errors.messages.length, 2);
    },
});

/**
 * Purpose: Verify follow-up mode selects the correct controller API and that process
 * teardown releases every loaded controller regardless of prior message activity.
 * Expect: Follow-up reaches the target, settlement fires, and every controller is disposed.
 * Method: Load two controllers, submit follow_up to the first, await settlement,
 * inspect response/call routing, invoke disposeAll, then verify both disposals and empty state.
 */
Deno.test({
    name: "workspace dispatches queued messages and disposes all sessions",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const settled = deferred<void>();
        const first = fakeController("session-a");
        const second = fakeController("session-b");
        const workspace = createWorkspace(
            new AgentEventBus(),
            [first, second],
            () => [],
            2,
        );
        await workspace.createLoadedSession();
        await workspace.createLoadedSession();

        const response = workspace.submitMessage(
            "session-a",
            { mode: "follow_up", text: "later" },
            () => settled.resolve(),
        );
        await settled.promise;

        assert.equal(response.turnId, undefined);
        assert.equal(stateOf(first).followUpCalls, 1);
        await workspace.disposeAll();
        assert.equal(stateOf(first).disposeCalls, 1);
        assert.equal(stateOf(second).disposeCalls, 1);
        assert.deepEqual(workspace.loadedSessions(), []);
    },
});

/**
 * Purpose: Verify the workspace and real Pi SDK preserve entry-scoped fork semantics:
 * physical branch truncation, lineage metadata, naming, and immediate loaded availability.
 * Expect: The fork excludes later entries, records its name/parent, and joins the loaded set.
 * Method: Persist two real user/assistant turns in a temp session directory, fork at
 * user two through workspace dependencies, reopen JSONL, and compare IDs/header/name/state.
 */
Deno.test({
    name:
        "workspace materializes an entry-scoped fork with only the selected branch",
    permissions: { env: true, read: true, write: true, sys: ["homedir"] },
    async fn() {
        const tempDir = await Deno.makeTempDir({
            prefix: "agentaz-entry-fork-test-",
        });
        try {
            const sessionDir = join(tempDir, "sessions");
            const sourceManager = SessionManager.create(
                "/tmp/agentaz-project",
                sessionDir,
            );
            const firstUserId = sourceManager.appendMessage(
                testMessage("user", "first question"),
            );
            const firstAssistantId = sourceManager.appendMessage(
                testMessage("assistant", "first answer"),
            );
            const secondUserId = sourceManager.appendMessage(
                testMessage("user", "second question"),
            );
            const excludedAssistantId = sourceManager.appendMessage(
                testMessage("assistant", "excluded answer"),
            );
            const sourceFile = sourceManager.getSessionFile();
            assert.ok(sourceFile);

            const source = fakeController(sourceManager.getSessionId(), {
                sessionFile: sourceFile,
                entries: sourceManager.getBranch(),
                sessionManager: sourceManager,
            });
            let openedFile: string | undefined;
            const workspace = createWorkspace(
                new AgentEventBus(),
                [source],
                () => [],
                2,
                () => listSessionFiles(sessionDir),
                (options) => {
                    openedFile = options.sessionFile;
                    const manager = SessionManager.open(
                        options.sessionFile,
                        undefined,
                        options.cwd,
                    );
                    return fakeController(manager.getSessionId(), {
                        sessionFile: options.sessionFile,
                        entries: manager.getBranch(),
                        sessionManager: manager,
                    });
                },
            );
            await workspace.createLoadedSession();

            const forked = await workspace.forkSession(
                sourceManager.getSessionId(),
                { entryId: secondUserId, name: "Selected branch" },
            );

            assert.ok(openedFile);
            assert.notEqual(openedFile, sourceFile);
            const persistedFork = SessionManager.open(
                openedFile,
                undefined,
                "/tmp/agentaz-project",
            );
            const forkedMessageIds = persistedFork.getEntries()
                .filter((entry) => entry.type === "message")
                .map((entry) => entry.id);
            assert.deepEqual(forkedMessageIds, [
                firstUserId,
                firstAssistantId,
                secondUserId,
            ]);
            assert.ok(!forkedMessageIds.includes(excludedAssistantId));
            assert.equal(persistedFork.getSessionName(), "Selected branch");
            assert.equal(
                persistedFork.getHeader()?.parentSession,
                sourceFile,
            );
            assert.equal(forked.sessionFile, openedFile);
            assert.deepEqual(
                workspace.loadedSessions().map((session) => session.sessionId),
                [sourceManager.getSessionId(), persistedFork.getSessionId()],
            );
        }
        finally {
            await Deno.remove(tempDir, { recursive: true });
        }
    },
});

/**
 * Purpose: Prevent unsupported user-only branches from reaching Pi's deferred-file path,
 * which would violate the API guarantee that a returned fork is immediately loadable.
 * Expect: The workspace throws SessionForkUnavailableError without changing loaded sessions.
 * Method: Load a fake controller whose current branch is one user entry, request an
 * entry-scoped fork, then inspect the typed error, loaded set, and source disposal count.
 */
Deno.test({
    name: "workspace rejects entry forks before the first assistant response",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const source = fakeController("session-a", {
            entries: [{
                type: "message",
                id: "user-entry",
                parentId: null,
                timestamp: new Date(0).toISOString(),
                message: {
                    role: "user",
                    content: [{ type: "text", text: "hello" }],
                    timestamp: Date.now(),
                },
            }],
        });
        const workspace = createWorkspace(
            new AgentEventBus(),
            [source],
            () => [],
            2,
        );
        await workspace.createLoadedSession();

        await assert.rejects(
            () =>
                workspace.forkSession("session-a", {
                    entryId: "user-entry",
                }),
            SessionForkUnavailableError,
        );

        assert.deepEqual(
            workspace.loadedSessions().map((session) => session.sessionId),
            ["session-a"],
        );
        assert.equal(stateOf(source).disposeCalls, 0);
    },
});

/**
 * Purpose: Prevent authenticated callers from making SessionManager open or rewrite files
 * outside the current cwd's enumerated persisted-session set.
 * Expect: An out-of-scope open fails before eviction or controller construction.
 * Method: Fill a one-slot workspace, expose only its legitimate file from the list
 * dependency, request an outside path, then verify rejection precedes eviction/open.
 */
Deno.test({
    name: "workspace rejects out-of-scope session files before eviction",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const loaded = fakeController("session-a");
        const unexpected = fakeController("unexpected");
        const workspace = createWorkspace(
            new AgentEventBus(),
            [loaded, unexpected],
            () => [],
            1,
            () =>
                Promise.resolve([
                    persistedSession("/tmp/session-a.jsonl", "session-a"),
                ]),
        );
        await workspace.createLoadedSession();

        await assert.rejects(
            () => workspace.openLoadedSession("/tmp/outside.jsonl"),
            PersistedSessionNotFoundError,
        );

        assert.deepEqual(
            workspace.loadedSessions().map((session) => session.sessionId),
            ["session-a"],
        );
        assert.equal(stateOf(loaded).disposeCalls, 0);
        assert.equal(stateOf(unexpected).seededRevisions.length, 0);
    },
});

/**
 * Purpose: Verify controller replacement cannot move the browser's transcript revision
 * backward and allow stale HTTP history responses to overwrite newer state.
 * Expect: The reopened controller receives a newer generation while prior instances dispose.
 * Method: Give controller A revision 7, evict it with B, reopen A from the persisted
 * list as a new controller, then inspect seeded revision and both prior disposal counts.
 */
Deno.test({
    name: "workspace preserves history revision across eviction and reopen",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const original = fakeController("session-a", { revision: 7 });
        const replacement = fakeController("session-b");
        const reopened = fakeController("session-a");
        const workspace = createWorkspace(
            new AgentEventBus(),
            [original, replacement, reopened],
            () => [],
            1,
            () =>
                Promise.resolve([
                    persistedSession("/tmp/session-a.jsonl", "session-a"),
                ]),
        );

        await workspace.createLoadedSession();
        await workspace.createLoadedSession();
        await workspace.openLoadedSession("/tmp/session-a.jsonl");

        const originalRevision = stateOf(original).seededRevisions.at(-1);
        const reopenedRevision = stateOf(reopened).seededRevisions.at(-1);
        assert.ok(originalRevision !== undefined);
        assert.ok(reopenedRevision !== undefined);
        assert.ok(reopenedRevision > originalRevision);
        assert.equal(stateOf(original).disposeCalls, 1);
        assert.equal(stateOf(replacement).disposeCalls, 1);
    },
});

/**
 * Purpose: Prove revision retention stays O(1) across an unbounded sequence of
 * distinct session IDs while a reopened controller still starts above stale state.
 * Expect: One numeric generation replaces per-session bookkeeping and reopen advances it.
 * Method: Cycle 200 one-slot controllers, reopen the first, then inspect seeds and shape.
 */
Deno.test({
    name:
        "workspace uses one revision generation across many distinct sessions",
    permissions: { env: true, read: true, sys: ["homedir"] },
    async fn() {
        const sessionCount = 200;
        const distinct = Array.from(
            { length: sessionCount },
            (_, index) => fakeController(`session-${index}`),
        );
        const original = distinct[0];
        assert.ok(original);
        const reopened = fakeController("session-0");
        const workspace = createWorkspace(
            new AgentEventBus(),
            [...distinct, reopened],
            () => [],
            1,
            () =>
                Promise.resolve([
                    persistedSession("/tmp/session-0.jsonl", "session-0"),
                ]),
        );

        for (let index = 0; index < sessionCount; index += 1) {
            await workspace.createLoadedSession();
        }
        await workspace.openLoadedSession("/tmp/session-0.jsonl");

        const originalRevision = stateOf(original).seededRevisions.at(-1);
        const reopenedRevision = stateOf(reopened).seededRevisions.at(-1);
        assert.ok(originalRevision !== undefined);
        assert.ok(reopenedRevision !== undefined);
        assert.ok(reopenedRevision > originalRevision);

        const revisionState = workspace as unknown as Record<string, unknown>;
        assert.equal(typeof revisionState.historyRevisionGeneration, "number");
        assert.equal("historyRevisionBySessionId" in revisionState, false);
    },
});

function persistedSession(file: string, sessionId: string) {
    return {
        file,
        sessionId,
        name: sessionId,
        createdAt: 0,
        updatedAt: 0,
    };
}

function createWorkspace(
    eventBus: AgentEventBus,
    controllers: ControllerBase[],
    protectedIds: () => Iterable<string>,
    maxLoadedSessions: number,
    listPersistedSessions: PiSessionWorkspaceDependencies[
        "listPersistedSessions"
    ] = () => Promise.resolve([]),
    openController:
        PiSessionWorkspaceDependencies["controllerFactory"]["open"] = () =>
            requireNextController(controllers),
    createController:
        PiSessionWorkspaceDependencies["controllerFactory"]["create"] = () =>
            requireNextController(controllers),
) {
    const dependencies: PiSessionWorkspaceDependencies = {
        agentDir: "/tmp/agentaz-workspace-test",
        ensureRequiredPackages: (agentDir) =>
            Promise.resolve({
                settingsPath: `${agentDir}/settings.json`,
                added: [],
            }),
        listPersistedSessions,
        controllerFactory: {
            create: createController,
            open: openController,
        },
    };
    return new PiSessionWorkspace(
        {
            cwd: "/tmp/agentaz-project",
            approvalTimeoutMs: 100,
            maxLoadedSessions,
        },
        eventBus,
        protectedIds,
        dependencies,
    );
}

function requireNextController(controllers: ControllerBase[]) {
    const controller = controllers.shift();
    assert.ok(controller, "test controller queue should not be empty");
    return controller;
}

type FakeState = {
    disposeCalls: number;
    promptCalls: number;
    followUpCalls: number;
    seededRevisions: number[];
};

const fakeStates = new WeakMap<ControllerBase, FakeState>();

function fakeController(
    sessionId: string,
    options: {
        busy?: boolean;
        prompt?: () => Promise<void>;
        revision?: number;
        entries?: ReturnType<ControllerBase["getEntries"]>;
        sessionFile?: string;
        sessionManager?: SessionManager;
        dispose?: () => Promise<void>;
    } = {},
): ControllerBase {
    let revision = options.revision ?? 0;
    const state: FakeState = {
        disposeCalls: 0,
        promptCalls: 0,
        followUpCalls: 0,
        seededRevisions: [],
    };
    const controller = {
        sessionId,
        sessionFile: options.sessionFile ?? `/tmp/${sessionId}.jsonl`,
        toLoadedSession: () => ({
            file: options.sessionFile ?? `/tmp/${sessionId}.jsonl`,
            sessionId,
            sessionFile: options.sessionFile ?? `/tmp/${sessionId}.jsonl`,
            isWorking: options.busy ?? false,
            isStreaming: false,
            pendingMessageCount: 0,
            pendingApprovalCount: 0,
            pendingUiRequests: [],
            extensionWidgets: [],
        }),
        rename: () => Promise.resolve(),
        isBusy: () => options.busy ?? false,
        dispose: () => {
            state.disposeCalls += 1;
            return options.dispose?.() ?? Promise.resolve();
        },
        getHistory: () => ({ sessionId, revision: 0, messages: [] }),
        compact: () =>
            Promise.resolve({
                summary: "",
                firstKeptEntryId: "",
                tokensBefore: 0,
                revision: 1,
            }),
        getEntries: () => options.entries ?? [],
        getSessionManager: () => {
            if (!options.sessionManager) {
                throw new Error("session manager not used by this test");
            }
            return options.sessionManager;
        },
        historyRevision: () => revision,
        seedHistoryRevision: (seededRevision: number) => {
            state.seededRevisions.push(seededRevision);
            revision = Math.max(revision, seededRevision);
        },
        getModelState: () => ({
            sessionId,
            models: [],
            thinkingLevel: "off" as const,
            availableThinkingLevels: ["off" as const],
        }),
        setModel: () =>
            Promise.resolve({
                sessionId,
                models: [],
                thinkingLevel: "off" as const,
                availableThinkingLevels: ["off" as const],
            }),
        setThinkingLevel: () =>
            Promise.resolve({
                sessionId,
                models: [],
                thinkingLevel: "off" as const,
                availableThinkingLevels: ["off" as const],
            }),
        prompt: () => {
            state.promptCalls += 1;
            return options.prompt?.() ?? Promise.resolve();
        },
        steer: () => Promise.resolve(),
        followUp: () => {
            state.followUpCalls += 1;
            return Promise.resolve();
        },
        abort: () => Promise.resolve(),
        clearQueue: () => Promise.resolve(),
        resolveConfirm: () => {},
        resolveInput: () => {},
        resolveSelect: () => {},
    } satisfies ControllerBase;
    fakeStates.set(controller, state);
    return controller;
}

function testMessage(role: "user" | "assistant", text: string) {
    return {
        role,
        content: [{ type: "text" as const, text }],
        timestamp: Date.now(),
    } as Parameters<SessionManager["appendMessage"]>[0];
}

async function listSessionFiles(sessionDir: string) {
    const sessions = [];
    for await (const entry of Deno.readDir(sessionDir)) {
        if (entry.isFile && entry.name.endsWith(".jsonl")) {
            const file = join(sessionDir, entry.name);
            sessions.push(persistedSession(file, entry.name));
        }
    }
    return sessions;
}

function stateOf(controller: ControllerBase) {
    const state = fakeStates.get(controller);
    assert.ok(state);
    return state;
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object";
}

function captureConsoleErrors() {
    const original = console.error;
    const messages: unknown[][] = [];
    console.error = (...args: unknown[]) => {
        messages.push(args);
    };
    return {
        messages,
        [Symbol.dispose]() {
            console.error = original;
        },
    };
}
