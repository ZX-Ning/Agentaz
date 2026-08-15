import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
    type SessionEntry,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
    ModelStateResponse,
    ThinkingLevel,
    UiRequestResponseRequest,
    UiRuntimeLoadedSession,
    UiSessionSummary,
} from "@agentaz/protocol";
import {
    BadRequestError,
    PersistedSessionNotFoundError,
    SessionBusyError,
    SessionLimitReachedError,
} from "../../src/errors.ts";
import type { ControllerBase } from "../../src/pi/session-controller.ts";
import { toUiSessionSummary } from "../../src/pi/session-normalization.ts";
import {
    PiSessionWorkspace,
    type PiSessionWorkspaceDependencies,
} from "../../src/pi/session-workspace.ts";
import { AgentEventBus } from "../../src/runtime/event-bus.ts";

/**
 * Purpose: Verify path-normalized open deduplication and loaded/unloaded rename
 * behavior without evicting or reopening an existing controller.
 * Expect: Equivalent paths reuse the controller; renames reach the correct persistence owner.
 * Method: Load one fake, reopen through a dotted path, then rename fake and real managers.
 */
Deno.test("workspace deduplicates open paths and renames loaded or dormant sessions", async () => {
    const root = await Deno.makeTempDir();
    const cwd = join(root, "cwd");
    const sessionDir = join(root, "sessions");
    await Deno.mkdir(cwd, { recursive: true });
    const manager = persistedManager(cwd, sessionDir, "question", "answer");
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    const loaded = new FakeController(manager.getSessionId(), {
        sessionFile,
        manager,
    });
    let openCalls = 0;
    const workspace = createWorkspace({
        cwd,
        controllers: [loaded],
        list: () => Promise.resolve([summary(sessionFile, loaded.sessionId)]),
        open: () => {
            openCalls += 1;
            return new FakeController("unexpected");
        },
    });

    try {
        await workspace.createLoadedSession();
        const reopened = await workspace.openLoadedSession(
            join(sessionDir, ".", sessionFile.split("/").at(-1)!),
        );
        assert.equal(reopened, loaded);
        assert.equal(openCalls, 0);

        await workspace.renamePersistedSession(sessionFile, "Loaded name");
        assert.deepEqual(loaded.renameCalls, ["Loaded name"]);
        await assert.rejects(
            () => workspace.renamePersistedSession(sessionFile, " "),
            BadRequestError,
        );
        await assert.rejects(
            () =>
                workspace.renamePersistedSession(sessionFile, "x".repeat(121)),
            BadRequestError,
        );
        await assert.rejects(
            () =>
                workspace.renamePersistedSession(
                    join(root, "outside.jsonl"),
                    "Name",
                ),
            PersistedSessionNotFoundError,
        );

        await loaded.dispose();
        const dormantWorkspace = createWorkspace({
            cwd,
            list: () =>
                Promise.resolve([summary(sessionFile, loaded.sessionId)]),
        });
        await dormantWorkspace.renamePersistedSession(
            sessionFile,
            "Dormant name",
        );
        assert.equal(
            SessionManager.open(sessionFile, undefined, cwd).getSessionName(),
            "Dormant name",
        );
    }
    finally {
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Verify soft deletion is safe for loaded, dormant, and busy sessions.
 * Expect: Idle files are renamed and loaded controllers disposed; busy deletion rejects untouched.
 * Method: Delete one loaded and one dormant JSONL file, then attempt a busy loaded delete.
 */
Deno.test("workspace soft-deletes idle sessions and rejects busy sessions", async () => {
    const root = await Deno.makeTempDir();
    const cwd = join(root, "cwd");
    await Deno.mkdir(cwd, { recursive: true });
    const loadedFile = join(root, "loaded.jsonl");
    const dormantFile = join(root, "dormant.jsonl");
    const busyFile = join(root, "busy.jsonl");
    await Promise.all([
        Deno.writeTextFile(loadedFile, "loaded"),
        Deno.writeTextFile(dormantFile, "dormant"),
        Deno.writeTextFile(busyFile, "busy"),
    ]);
    const loaded = new FakeController("loaded", { sessionFile: loadedFile });
    const loadedRecovery = new FakeController("loaded", {
        sessionFile: loadedFile,
    });
    const events: unknown[] = [];
    const eventBus = new AgentEventBus();
    eventBus.subscribe((event) => events.push(event));
    const list = () =>
        Promise.resolve([
            summary(loadedFile, "loaded"),
            summary(dormantFile, "dormant"),
            summary(busyFile, "busy"),
        ]);

    try {
        const workspace = createWorkspace({
            cwd,
            controllers: [loaded],
            list,
            eventBus,
            open: () => loadedRecovery,
        });
        await workspace.createLoadedSession();
        const removedLoaded = await workspace.softDeletePersistedSession(
            loadedFile,
        );
        assert.equal(removedLoaded.sessionId, "loaded");
        assert.equal(loaded.disposeCalls, 1);
        assert.equal(await exists(loadedFile), false);
        assert.equal(await exists(`${loadedFile}.deleted`), true);
        assert.ok(
            events.some((event) =>
                isRecord(event) && event.type === "session_removed" &&
                event.sessionId === "loaded"
            ),
        );

        const removedDormant = await workspace.softDeletePersistedSession(
            dormantFile,
        );
        assert.equal(removedDormant.sessionId, undefined);
        assert.equal(await exists(dormantFile), false);
        assert.equal(await exists(`${dormantFile}.deleted`), true);

        const busy = new FakeController("busy", {
            sessionFile: busyFile,
            busy: true,
        });
        const busyWorkspace = createWorkspace({
            cwd,
            controllers: [busy],
            list,
        });
        await busyWorkspace.createLoadedSession();
        await assert.rejects(
            () => busyWorkspace.softDeletePersistedSession(busyFile),
            SessionBusyError,
        );
        assert.equal(await exists(busyFile), true);
        assert.equal(busy.disposeCalls, 0);
    }
    finally {
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Prevent a prompt from starting after soft-delete has accepted an idle owner.
 * Expect: Normal mutations report SessionBusyError until the lifecycle transition settles.
 * Method: Pause destination resolution after the idle check, submit a prompt, then finish delete.
 */
Deno.test("workspace blocks mutations throughout loaded soft-delete", async () => {
    const root = await Deno.makeTempDir();
    const sourceFile = join(root, "session.jsonl");
    await Deno.writeTextFile(sourceFile, "session");
    const destinationEntered = deferred<void>();
    const releaseDestination = deferred<boolean>();
    const original = new FakeController("session", { sessionFile: sourceFile });
    const recovery = new FakeController("session", { sessionFile: sourceFile });
    const workspace = createWorkspace({
        controllers: [original],
        list: () => Promise.resolve([summary(sourceFile, original.sessionId)]),
        open: () => recovery,
        softDeleteFileSystem: {
            fileExists: () => {
                destinationEntered.resolve();
                return releaseDestination.promise;
            },
            rename: (source, destination) => Deno.rename(source, destination),
        },
    });

    try {
        await workspace.createLoadedSession();
        const deleting = workspace.softDeletePersistedSession(sourceFile);
        await destinationEntered.promise;

        assert.throws(
            () =>
                workspace.submitMessage("session", {
                    mode: "prompt",
                    clientMessageId: "delete-race",
                    text: "must not start",
                }),
            SessionBusyError,
        );

        releaseDestination.resolve(false);
        await deleting;
        assert.equal(original.disposeCalls, 1);
        assert.equal(await exists(`${sourceFile}.deleted`), true);
    }
    finally {
        releaseDestination.resolve(false);
        await workspace.disposeAll();
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Keep revert recoverable when replacement construction fails after persistence.
 * Expect: The original controller remains registered on the reverted branch with a newer revision.
 * Method: Inject an open-factory failure after branch()/appendSessionInfo(), then inspect ownership.
 */
Deno.test("workspace keeps the original controller when revert replacement fails", async () => {
    const root = await Deno.makeTempDir();
    const cwd = join(root, "cwd");
    const sessionDir = join(root, "sessions");
    await Deno.mkdir(cwd, { recursive: true });
    const manager = persistedManager(cwd, sessionDir, "one", "answer one");
    const targetEntry = manager.getBranch().at(-1)?.id;
    assert.ok(targetEntry);
    manager.appendMessage(testMessage("user", "two"));
    manager.appendMessage(testMessage("assistant", "answer two"));
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    const original = new FakeController(manager.getSessionId(), {
        sessionFile,
        manager,
        revision: 7,
    });
    const workspace = createWorkspace({
        cwd,
        controllers: [original],
        list: () => Promise.resolve([summary(sessionFile, original.sessionId)]),
        open: () => {
            throw new Error("replacement failed");
        },
    });

    try {
        await workspace.createLoadedSession();
        await assert.rejects(
            () => workspace.revertSession(original.sessionId, targetEntry),
            /replacement failed/,
        );

        assert.equal(workspace.hasSession(original.sessionId), true);
        assert.equal(original.disposeCalls, 0);
        assert.equal(original.seededRevisions.length, 2);
        assert.ok(
            original.seededRevisions[1]! > original.seededRevisions[0]!,
        );
        assert.equal(
            messageIds(original.getSessionManager()).at(-1),
            targetEntry,
        );
    }
    finally {
        await workspace.disposeAll();
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Keep replacement ownership committed when old-controller cleanup fails.
 * Expect: Revert rejects with the cleanup error but the replacement remains registered and usable.
 * Method: Inject dispose failure on the original after a successful replacement factory call.
 */
Deno.test("workspace retains revert replacement after old-controller dispose failure", async () => {
    const root = await Deno.makeTempDir();
    const cwd = join(root, "cwd");
    const sessionDir = join(root, "sessions");
    await Deno.mkdir(cwd, { recursive: true });
    const manager = persistedManager(cwd, sessionDir, "one", "answer one");
    const targetEntry = manager.getBranch().at(-1)?.id;
    assert.ok(targetEntry);
    manager.appendMessage(testMessage("user", "two"));
    manager.appendMessage(testMessage("assistant", "answer two"));
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    const cleanupError = new Error("old dispose failed");
    const original = new FakeController(manager.getSessionId(), {
        sessionFile,
        manager,
        revision: 2,
        disposeError: cleanupError,
    });
    const replacementManager = SessionManager.open(
        sessionFile,
        undefined,
        cwd,
    );
    const replacement = new FakeController(original.sessionId, {
        sessionFile,
        manager: replacementManager,
    });
    const workspace = createWorkspace({
        cwd,
        controllers: [original],
        list: () => Promise.resolve([summary(sessionFile, original.sessionId)]),
        open: () => replacement,
    });

    try {
        await workspace.createLoadedSession();
        await assert.rejects(
            () => workspace.revertSession(original.sessionId, targetEntry),
            cleanupError,
        );

        assert.equal(original.disposeCalls, 1);
        assert.equal(workspace.hasSession(replacement.sessionId), true);
        assert.ok(
            replacement.seededRevisions[0]! >
                original.seededRevisions[0]!,
        );
        assert.equal(
            workspace.loadedSessions()[0]?.sessionId,
            replacement.sessionId,
        );
    }
    finally {
        await workspace.disposeAll();
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Ensure soft-delete destination failure occurs before ownership changes.
 * Expect: The original loaded controller and source file remain untouched with no removal event.
 * Method: Inject a failing destination existence check and inspect state/events.
 */
Deno.test("workspace leaves loaded state untouched when delete destination calculation fails", async () => {
    const root = await Deno.makeTempDir();
    const sourceFile = join(root, "session.jsonl");
    await Deno.writeTextFile(sourceFile, "session");
    const original = new FakeController("session", { sessionFile: sourceFile });
    const events: unknown[] = [];
    const eventBus = new AgentEventBus();
    eventBus.subscribe((event) => events.push(event));
    const workspace = createWorkspace({
        controllers: [original],
        eventBus,
        list: () => Promise.resolve([summary(sourceFile, original.sessionId)]),
        softDeleteFileSystem: {
            fileExists: () => Promise.reject(new Error("destination failed")),
            rename: (source, destination) => Deno.rename(source, destination),
        },
    });

    try {
        await workspace.createLoadedSession();
        await assert.rejects(
            () => workspace.softDeletePersistedSession(sourceFile),
            /destination failed/,
        );

        assert.equal(workspace.hasSession(original.sessionId), true);
        assert.equal(original.disposeCalls, 0);
        assert.equal(await exists(sourceFile), true);
        assert.equal(removalEvents(events).length, 0);
    }
    finally {
        await workspace.disposeAll();
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Recover loaded ownership when the soft-delete rename fails before commit.
 * Expect: A prepared replacement remains registered, the source stays present, and no removal emits.
 * Method: Inject rename failure after the original controller is safely replaced.
 */
Deno.test("workspace recovers a loaded session after soft-delete rename failure", async () => {
    const root = await Deno.makeTempDir();
    const sourceFile = join(root, "session.jsonl");
    await Deno.writeTextFile(sourceFile, "session");
    const original = new FakeController("session", { sessionFile: sourceFile });
    const recovery = new FakeController("session", { sessionFile: sourceFile });
    const events: unknown[] = [];
    const eventBus = new AgentEventBus();
    eventBus.subscribe((event) => events.push(event));
    const workspace = createWorkspace({
        controllers: [original],
        eventBus,
        list: () => Promise.resolve([summary(sourceFile, original.sessionId)]),
        open: () => recovery,
        softDeleteFileSystem: {
            fileExists: () => Promise.resolve(false),
            rename: () => Promise.reject(new Error("rename failed")),
        },
    });

    try {
        await workspace.createLoadedSession();
        await assert.rejects(
            () => workspace.softDeletePersistedSession(sourceFile),
            /rename failed/,
        );

        assert.equal(original.disposeCalls, 1);
        assert.equal(workspace.hasSession(recovery.sessionId), true);
        assert.ok(
            recovery.seededRevisions[0]! > original.seededRevisions[0]!,
        );
        assert.equal(await exists(sourceFile), true);
        assert.equal(removalEvents(events).length, 0);
    }
    finally {
        await workspace.disposeAll();
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Roll back a committed rename when post-rename controller cleanup fails.
 * Expect: The source file and a fresh replacement are restored without a removal event.
 * Method: Fail disposal of the first recovery controller, then supply a second on reopen.
 */
Deno.test("workspace rolls back soft-delete after post-rename cleanup failure", async () => {
    const root = await Deno.makeTempDir();
    const sourceFile = join(root, "session.jsonl");
    await Deno.writeTextFile(sourceFile, "session");
    const cleanupError = new Error("recovery dispose failed");
    const original = new FakeController("session", { sessionFile: sourceFile });
    const failedRecovery = new FakeController("session", {
        sessionFile: sourceFile,
        disposeError: cleanupError,
    });
    const restored = new FakeController("session", { sessionFile: sourceFile });
    const replacements = [failedRecovery, restored];
    const events: unknown[] = [];
    const eventBus = new AgentEventBus();
    eventBus.subscribe((event) => events.push(event));
    const workspace = createWorkspace({
        controllers: [original],
        eventBus,
        list: () => Promise.resolve([summary(sourceFile, original.sessionId)]),
        open: () => requireController(replacements),
    });

    try {
        await workspace.createLoadedSession();
        await assert.rejects(
            () => workspace.softDeletePersistedSession(sourceFile),
            cleanupError,
        );

        assert.equal(original.disposeCalls, 1);
        assert.equal(failedRecovery.disposeCalls, 1);
        assert.equal(workspace.hasSession(restored.sessionId), true);
        assert.ok(
            restored.seededRevisions[0]! >
                failedRecovery.seededRevisions[0]!,
        );
        assert.equal(await exists(sourceFile), true);
        assert.equal(await exists(`${sourceFile}.deleted`), false);
        assert.equal(removalEvents(events).length, 0);
    }
    finally {
        await workspace.disposeAll();
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Verify full fork and in-place revert preserve Pi branch semantics while
 * replacing controllers and maintaining monotonic browser history revisions.
 * Expect: Full fork copies history; revert truncates later turns and seeds revision +1.
 * Method: Use real SessionManagers behind fake controllers and inspect reopened JSONL branches.
 */
Deno.test("workspace full fork and revert preserve branches and revisions", async () => {
    const root = await Deno.makeTempDir();
    using _agentDir = withEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    const cwd = join(root, "cwd");
    const sourceDir = join(root, "source-sessions");
    await Deno.mkdir(cwd, { recursive: true });
    const sourceManager = SessionManager.create(cwd, sourceDir);
    const firstUser = sourceManager.appendMessage(testMessage("user", "one"));
    const firstAssistant = sourceManager.appendMessage(
        testMessage("assistant", "answer one"),
    );
    const secondUser = sourceManager.appendMessage(testMessage("user", "two"));
    const secondAssistant = sourceManager.appendMessage(
        testMessage("assistant", "answer two"),
    );
    const sourceFile = sourceManager.getSessionFile();
    assert.ok(sourceFile);
    const source = new FakeController(sourceManager.getSessionId(), {
        sessionFile: sourceFile,
        manager: sourceManager,
        revision: 3,
    });
    const opened: FakeController[] = [];
    const list = async (listCwd: string) => [
        summary(sourceFile, source.sessionId),
        ...(await SessionManager.list(listCwd)).map(toUiSessionSummary),
    ];
    const workspace = createWorkspace({
        cwd,
        controllers: [source],
        list,
        maxLoadedSessions: 3,
        open: (options) => {
            const manager = SessionManager.open(
                options.sessionFile,
                undefined,
                cwd,
            );
            const controller = new FakeController(manager.getSessionId(), {
                sessionFile: options.sessionFile,
                manager,
            });
            opened.push(controller);
            return controller;
        },
    });

    try {
        await workspace.createLoadedSession();
        const forked = await workspace.forkSession(source.sessionId, {});
        assert.notEqual(forked.sessionFile, sourceFile);
        const forkManager = SessionManager.open(
            forked.sessionFile!,
            undefined,
            cwd,
        );
        assert.deepEqual(messageIds(forkManager), [
            firstUser,
            firstAssistant,
            secondUser,
            secondAssistant,
        ]);
        assert.equal(forkManager.getHeader()?.parentSession, sourceFile);

        const reverted = await workspace.revertSession(
            source.sessionId,
            firstAssistant,
        );
        assert.equal(source.disposeCalls, 1);
        const revertedManager = reverted.getSessionManager();
        assert.deepEqual(messageIds(revertedManager), [
            firstUser,
            firstAssistant,
        ]);
        const revertedFake = opened.at(-1);
        assert.ok(revertedFake);
        assert.ok(
            revertedFake.seededRevisions[0]! >
                source.seededRevisions[0]!,
        );
    }
    finally {
        await workspace.disposeAll();
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Refuse a fork before materialization when no load-capacity reservation exists.
 * Expect: A protected source in a one-slot workspace yields SessionLimitReachedError and no file.
 * Method: Snapshot JSONL files around a full-fork request whose only owner is the source.
 */
Deno.test("workspace preflights fork capacity before creating its JSONL file", async () => {
    const root = await Deno.makeTempDir();
    using _agentDir = withEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    const cwd = join(root, "cwd");
    const sourceDir = join(root, "source-sessions");
    await Deno.mkdir(cwd, { recursive: true });
    const manager = persistedManager(cwd, sourceDir, "one", "answer one");
    const sourceFile = manager.getSessionFile();
    assert.ok(sourceFile);
    const source = new FakeController(manager.getSessionId(), {
        sessionFile: sourceFile,
        manager,
    });
    const workspace = createWorkspace({
        cwd,
        controllers: [source],
        list: () => Promise.resolve([summary(sourceFile, source.sessionId)]),
        maxLoadedSessions: 1,
    });

    try {
        await workspace.createLoadedSession();
        const before = await jsonlFiles(root);

        await assert.rejects(
            () => workspace.forkSession(source.sessionId, {}),
            SessionLimitReachedError,
        );

        assert.deepEqual(await jsonlFiles(root), before);
        assert.equal(workspace.hasSession(source.sessionId), true);
        assert.equal(source.disposeCalls, 0);
    }
    finally {
        await workspace.disposeAll();
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Roll back a materialized fork when its provisional controller cannot open.
 * Expect: The open error propagates, the new JSONL is removed, and the source stays loaded.
 * Method: Inject an open failure plus observable removal boundary and compare file snapshots.
 */
Deno.test("workspace removes an unowned fork after controller open fails", async () => {
    const root = await Deno.makeTempDir();
    using _agentDir = withEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    const cwd = join(root, "cwd");
    const sourceDir = join(root, "source-sessions");
    await Deno.mkdir(cwd, { recursive: true });
    const manager = persistedManager(cwd, sourceDir, "one", "answer one");
    const sourceFile = manager.getSessionFile();
    assert.ok(sourceFile);
    const source = new FakeController(manager.getSessionId(), {
        sessionFile: sourceFile,
        manager,
    });
    let removedFile: string | undefined;
    const list = async (listCwd: string) => [
        summary(sourceFile, source.sessionId),
        ...(await SessionManager.list(listCwd)).map(toUiSessionSummary),
    ];
    const workspace = createWorkspace({
        cwd,
        controllers: [source],
        list,
        maxLoadedSessions: 2,
        open: () => {
            throw new Error("fork open failed");
        },
        forkFileSystem: {
            remove: async (path) => {
                removedFile = path;
                await Deno.remove(path);
            },
        },
    });

    try {
        await workspace.createLoadedSession();
        const before = await jsonlFiles(root);

        await assert.rejects(
            () => workspace.forkSession(source.sessionId, {}),
            /fork open failed/,
        );

        assert.ok(removedFile);
        assert.equal(await exists(removedFile), false);
        assert.deepEqual(await jsonlFiles(root), before);
        assert.equal(workspace.hasSession(source.sessionId), true);
    }
    finally {
        await workspace.disposeAll();
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Preserve both causes when fork creation and rollback fail independently.
 * Expect: AggregateError contains the open and removal failures and refreshes persisted state.
 * Method: Fail provisional open and injected removal, then inspect aggregate causes/list calls.
 */
Deno.test("workspace aggregates fork open and rollback failures", async () => {
    const root = await Deno.makeTempDir();
    using _agentDir = withEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    const cwd = join(root, "cwd");
    const sourceDir = join(root, "source-sessions");
    await Deno.mkdir(cwd, { recursive: true });
    const manager = persistedManager(cwd, sourceDir, "one", "answer one");
    const sourceFile = manager.getSessionFile();
    assert.ok(sourceFile);
    const source = new FakeController(manager.getSessionId(), {
        sessionFile: sourceFile,
        manager,
    });
    const openError = new Error("fork open failed");
    const rollbackError = new Error("fork removal failed");
    let listCalls = 0;
    const list = async (listCwd: string) => {
        listCalls += 1;
        return [
            summary(sourceFile, source.sessionId),
            ...(await SessionManager.list(listCwd)).map(toUiSessionSummary),
        ];
    };
    const workspace = createWorkspace({
        cwd,
        controllers: [source],
        list,
        maxLoadedSessions: 2,
        open: () => {
            throw openError;
        },
        forkFileSystem: {
            remove: () => Promise.reject(rollbackError),
        },
    });

    try {
        await workspace.createLoadedSession();
        let failure: unknown;
        try {
            await workspace.forkSession(source.sessionId, {});
        }
        catch (error) {
            failure = error;
        }

        assert.ok(failure instanceof AggregateError);
        assert.deepEqual(failure.errors, [openError, rollbackError]);
        assert.ok(listCalls >= 2);
        assert.equal(workspace.hasSession(source.sessionId), true);
    }
    finally {
        await workspace.disposeAll();
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Verify compact/message/UI workspace adapters dispatch to the correct
 * controller methods and preserve settlement/state refresh behavior.
 * Expect: Busy compact rejects; idle compact returns protocol data; steer and UI kinds route exactly once.
 * Method: Exercise compact, steer, and all discriminated UI responses against one fake.
 */
Deno.test("workspace dispatches compact, steer, and UI response operations", async () => {
    const eventBus = new AgentEventBus();
    const events: unknown[] = [];
    eventBus.subscribe((event) => events.push(event));
    let refreshCalls = 0;
    const controller = new FakeController("session-a");
    const workspace = createWorkspace({
        controllers: [controller],
        eventBus,
        list: () => {
            refreshCalls += 1;
            return Promise.resolve([]);
        },
    });
    await workspace.createLoadedSession();

    controller.busy = true;
    await assert.rejects(
        () => workspace.compactSession("session-a", {}),
        SessionBusyError,
    );
    assert.equal(controller.compactCalls, 0);

    controller.busy = false;
    const compacted = await workspace.compactSession("session-a", {
        customInstructions: "keep decisions",
    });
    assert.deepEqual(compacted, {
        ok: true,
        sessionId: "session-a",
        summary: "summary",
        firstKeptEntryId: "entry-a",
        tokensBefore: 42,
        details: undefined,
        revision: controller.historyRevision(),
    });
    assert.deepEqual(controller.compactInstructions, ["keep decisions"]);
    assert.equal(refreshCalls, 1);

    const settled = Promise.withResolvers<void>();
    const response = workspace.submitMessage(
        "session-a",
        { mode: "steer", text: "redirect" },
        () => settled.resolve(),
    );
    await settled.promise;
    assert.equal(response.turnId, undefined);
    assert.equal(controller.steerCalls, 1);

    const responses: UiRequestResponseRequest[] = [
        { kind: "confirm", confirmed: true },
        { kind: "input", value: "value" },
        { kind: "select", selected: "choice" },
    ];
    for (const uiResponse of responses) {
        workspace.resolveUiRequest("session-a", "request-a", uiResponse);
    }
    assert.deepEqual(controller.uiResponses, responses);
    assert.ok(
        events.filter((event) =>
            isRecord(event) && event.type === "state_changed"
        ).length >= 6,
    );
});

function createWorkspace(options: {
    cwd?: string;
    controllers?: FakeController[];
    list?: (cwd: string) => Promise<UiSessionSummary[]>;
    open?: PiSessionWorkspaceDependencies["controllerFactory"]["open"];
    eventBus?: AgentEventBus;
    maxLoadedSessions?: number;
    softDeleteFileSystem?: PiSessionWorkspaceDependencies[
        "softDeleteFileSystem"
    ];
    forkFileSystem?: PiSessionWorkspaceDependencies["forkFileSystem"];
}) {
    const controllers = [...(options.controllers ?? [])];
    const dependencies: PiSessionWorkspaceDependencies = {
        agentDir: "/tmp/agentaz-workspace-mutation-test",
        ensureRequiredPackages: (agentDir) =>
            Promise.resolve({
                settingsPath: join(agentDir, "settings.json"),
                added: [],
            }),
        listPersistedSessions: options.list ?? (() => Promise.resolve([])),
        controllerFactory: {
            create: () => requireController(controllers),
            open: options.open ?? (() => requireController(controllers)),
        },
        softDeleteFileSystem: options.softDeleteFileSystem,
        forkFileSystem: options.forkFileSystem,
    };
    return new PiSessionWorkspace(
        {
            cwd: options.cwd ?? "/tmp/agentaz-project",
            approvalTimeoutMs: 100,
            maxLoadedSessions: options.maxLoadedSessions ?? 5,
        },
        options.eventBus ?? new AgentEventBus(),
        () => [],
        dependencies,
    );
}

class FakeController implements ControllerBase {
    readonly sessionId: string;
    readonly sessionFile: string | undefined;
    busy: boolean;
    disposeCalls = 0;
    renameCalls: string[] = [];
    compactCalls = 0;
    compactInstructions: Array<string | undefined> = [];
    steerCalls = 0;
    uiResponses: UiRequestResponseRequest[] = [];
    seededRevisions: number[] = [];
    private readonly manager?: SessionManager;
    private readonly entries: SessionEntry[];
    private revision: number;
    private readonly disposeError?: Error;

    constructor(
        sessionId: string,
        options: {
            sessionFile?: string;
            busy?: boolean;
            manager?: SessionManager;
            entries?: SessionEntry[];
            revision?: number;
            disposeError?: Error;
        } = {},
    ) {
        this.sessionId = sessionId;
        this.sessionFile = options.sessionFile ?? `/tmp/${sessionId}.jsonl`;
        this.busy = options.busy ?? false;
        this.manager = options.manager;
        this.entries = options.entries ?? options.manager?.getBranch() ?? [];
        this.revision = options.revision ?? 0;
        this.disposeError = options.disposeError;
    }

    historyRevision() {
        return this.revision;
    }

    seedHistoryRevision(revision: number) {
        this.seededRevisions.push(revision);
        this.revision = Math.max(this.revision, revision);
    }

    isBusy() {
        return this.busy;
    }

    rename(name: string) {
        this.renameCalls.push(name);
        this.manager?.appendSessionInfo(name);
        return Promise.resolve();
    }

    toLoadedSession(): UiRuntimeLoadedSession {
        return {
            file: this.sessionFile ?? this.sessionId,
            sessionId: this.sessionId,
            sessionFile: this.sessionFile,
            name: this.sessionId,
            createdAt: 0,
            updatedAt: 0,
            isWorking: this.busy,
            isStreaming: false,
            pendingMessageCount: 0,
            pendingApprovalCount: 0,
            pendingUiRequests: [],
            extensionWidgets: [],
        };
    }

    prompt() {
        return Promise.resolve();
    }

    steer() {
        this.steerCalls += 1;
        return Promise.resolve();
    }

    followUp() {
        return Promise.resolve();
    }

    abort() {
        return Promise.resolve();
    }

    clearQueue() {
        return Promise.resolve();
    }

    compact(customInstructions?: string) {
        this.compactCalls += 1;
        this.compactInstructions.push(customInstructions);
        this.revision += 1;
        return Promise.resolve({
            summary: "summary",
            firstKeptEntryId: "entry-a",
            tokensBefore: 42,
            revision: this.revision,
        });
    }

    getModelState(): ModelStateResponse {
        return modelState(this.sessionId);
    }

    setModel() {
        return Promise.resolve(modelState(this.sessionId));
    }

    setThinkingLevel(_level: ThinkingLevel) {
        return Promise.resolve(modelState(this.sessionId));
    }

    resolveSelect(_requestId: string, selected?: string) {
        this.uiResponses.push({ kind: "select", selected });
    }

    resolveInput(_requestId: string, value?: string) {
        this.uiResponses.push({ kind: "input", value });
    }

    resolveConfirm(_requestId: string, confirmed: boolean) {
        this.uiResponses.push({ kind: "confirm", confirmed });
    }

    dispose() {
        this.disposeCalls += 1;
        if (this.disposeError) {
            return Promise.reject(this.disposeError);
        }
        return Promise.resolve();
    }

    getHistory() {
        return {
            sessionId: this.sessionId,
            revision: this.revision,
            messages: [],
        };
    }

    getEntries() {
        return this.manager?.getBranch() ?? this.entries;
    }

    getSessionManager() {
        assert.ok(
            this.manager,
            "SessionManager is required for this operation",
        );
        return this.manager;
    }
}

function persistedManager(
    cwd: string,
    sessionDir: string,
    question: string,
    answer: string,
) {
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendMessage(testMessage("user", question));
    manager.appendMessage(testMessage("assistant", answer));
    return manager;
}

function testMessage(role: "user" | "assistant", text: string) {
    return {
        role,
        content: [{ type: "text" as const, text }],
        timestamp: Date.now(),
    } as Parameters<SessionManager["appendMessage"]>[0];
}

function messageIds(manager: SessionManager) {
    return manager.getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.id);
}

function modelState(sessionId: string): ModelStateResponse {
    return {
        sessionId,
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
    };
}

function summary(file: string, sessionId: string): UiSessionSummary {
    return {
        file: resolve(file),
        sessionId,
        name: sessionId,
        createdAt: 0,
        updatedAt: 0,
    };
}

function requireController(controllers: FakeController[]) {
    const controller = controllers.shift();
    assert.ok(controller, "test controller queue should not be empty");
    return controller;
}

async function exists(path: string) {
    try {
        await Deno.stat(path);
        return true;
    }
    catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return false;
        }
        throw error;
    }
}

async function jsonlFiles(root: string) {
    const files: string[] = [];
    for await (const entry of Deno.readDir(root)) {
        const path = join(root, entry.name);
        if (entry.isDirectory) {
            files.push(...await jsonlFiles(path));
        }
        else if (entry.isFile && entry.name.endsWith(".jsonl")) {
            files.push(path);
        }
    }
    return files.sort();
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

function removalEvents(events: unknown[]) {
    return events.filter((event) =>
        isRecord(event) && event.type === "session_removed"
    );
}

function withEnv(name: string, value: string | undefined) {
    const previous = Deno.env.get(name);
    if (value === undefined) {
        Deno.env.delete(name);
    }
    else {
        Deno.env.set(name, value);
    }
    return {
        [Symbol.dispose]() {
            if (previous === undefined) {
                Deno.env.delete(name);
            }
            else {
                Deno.env.set(name, previous);
            }
        },
    };
}
