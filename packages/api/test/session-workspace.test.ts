import assert from "node:assert/strict";
import { AgentEventBus } from "../src/runtime/event-bus.ts";
import {
    PiSessionWorkspace,
    type PiSessionWorkspaceDependencies,
    type WorkspaceSessionController,
} from "../src/pi/session-workspace.ts";
import {
    PersistedSessionNotFoundError,
    SessionLimitReachedError,
} from "../src/errors.ts";

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
            async () => {
                listCalls += 1;
                return [];
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

        assert.deepEqual(stateOf(reopened).seededRevisions, [7]);
        assert.equal(stateOf(original).disposeCalls, 1);
        assert.equal(stateOf(replacement).disposeCalls, 1);
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
    controllers: WorkspaceSessionController[],
    protectedIds: () => Iterable<string>,
    maxLoadedSessions: number,
    listPersistedSessions: PiSessionWorkspaceDependencies[
        "listPersistedSessions"
    ] = () => Promise.resolve([]),
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
            create: () => Promise.resolve(requireNextController(controllers)),
            open: () => requireNextController(controllers),
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

function requireNextController(controllers: WorkspaceSessionController[]) {
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

const fakeStates = new WeakMap<WorkspaceSessionController, FakeState>();

function fakeController(
    sessionId: string,
    options: {
        busy?: boolean;
        prompt?: () => Promise<void>;
        revision?: number;
    } = {},
): WorkspaceSessionController {
    const state: FakeState = {
        disposeCalls: 0,
        promptCalls: 0,
        followUpCalls: 0,
        seededRevisions: [],
    };
    const controller = {
        sessionId,
        sessionFile: `/tmp/${sessionId}.jsonl`,
        toLoadedSession: () => ({
            file: `/tmp/${sessionId}.jsonl`,
            sessionId,
            sessionFile: `/tmp/${sessionId}.jsonl`,
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
            return Promise.resolve();
        },
        getHistory: () => ({ sessionId, revision: 0, messages: [] }),
        compact: () =>
            Promise.resolve({
                summary: "",
                firstKeptEntryId: "",
                tokensBefore: 0,
                revision: 1,
            }),
        getEntries: () => [],
        getSessionManager: () => {
            throw new Error("session manager not used by this test");
        },
        historyRevision: () => options.revision ?? 0,
        seedHistoryRevision: (revision: number) => {
            state.seededRevisions.push(revision);
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
    } as unknown as WorkspaceSessionController;
    fakeStates.set(controller, state);
    return controller;
}

function stateOf(controller: WorkspaceSessionController) {
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
