import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ServerEvent, ThinkingLevel } from "@agentaz/protocol";
import {
    ContextCompactUnavailableError,
    UnknownModelError,
} from "../../src/errors.ts";
import {
    PiSessionController,
    supportedThinkingLevels,
} from "../../src/pi/session-controller.ts";

/**
 * Purpose: Verify prompt lifecycle emits correlation events around the SDK call
 * and forwards browser image payloads in Pi's expected shape.
 * Expect: Success emits started/completed; failure emits started/failed and rethrows.
 * Method: Run one resolving and one rejecting fake session prompt and inspect events/options.
 */
Deno.test("PiSessionController emits prompt success and failure lifecycle", async () => {
    const successEvents: ServerEvent[] = [];
    let promptOptions: unknown;
    const success = bareController({
        sessionId: "session-a",
        prompt: (_text: string, options: unknown) => {
            promptOptions = options;
            return Promise.resolve();
        },
    }, successEvents);

    await success.prompt(
        "hello",
        [{ mediaType: "image/png", data: "base64" }],
        { turnId: "turn-a", clientMessageId: "client-a" },
    );
    assert.deepEqual(successEvents.map((event) => event.type), [
        "turn_started",
        "turn_completed",
    ]);
    assert.deepEqual(promptOptions, {
        images: [{ type: "image", mimeType: "image/png", data: "base64" }],
    });
    const started = successEvents[0];
    assert.equal(started?.type, "turn_started");
    if (started?.type === "turn_started") {
        assert.equal(started.userMessage.clientMessageId, "client-a");
        assert.equal(started.userMessage.blocks[0]?.type, "text");
    }

    const failureEvents: ServerEvent[] = [];
    const failure = bareController({
        sessionId: "session-b",
        prompt: () => Promise.reject(new Error("provider failed")),
    }, failureEvents);
    await assert.rejects(
        () =>
            failure.prompt("hello", undefined, {
                turnId: "turn-b",
                clientMessageId: "client-b",
            }),
        /provider failed/,
    );
    assert.deepEqual(failureEvents.map((event) => event.type), [
        "turn_started",
        "turn_failed",
    ]);
    const failed = failureEvents.at(-1);
    assert.equal(failed?.type, "turn_failed");
    if (failed?.type === "turn_failed") {
        assert.equal(failed.turnId, "turn-b");
        assert.equal(failed.clientMessageId, "client-b");
        assert.equal(failed.message, "provider failed");
    }
});

/**
 * Purpose: Verify compaction maps known SDK availability errors, increments history
 * revision on success, and always clears busy state/sends status.
 * Expect: Known messages become typed 409 errors; unknown failures retain identity.
 * Method: Swap compact outcomes across fresh white-box controllers and inspect state.
 */
Deno.test("PiSessionController compaction maps errors and restores state", async () => {
    let statusCalls = 0;
    const success = bareController(
        {
            sessionId: "session-a",
            compact: () =>
                Promise.resolve({
                    summary: "summary",
                    firstKeptEntryId: "entry-a",
                    tokensBefore: 100,
                }),
        },
        [],
        { sendStatus: () => statusCalls++ },
    );
    Object.assign(success, { transcriptRevision: 4 });

    const compacted = await success.compact("keep decisions");
    assert.equal(compacted.revision, 5);
    assert.equal(success.historyRevision(), 5);
    assert.equal(success.isBusy(), false);
    assert.equal(statusCalls, 1);

    for (
        const message of [
            "Nothing to compact (session too small)",
            "Already compacted",
        ]
    ) {
        const controller = bareController(
            {
                sessionId: "session-a",
                compact: () => Promise.reject(new Error(message)),
            },
            [],
            { sendStatus: () => {} },
        );
        await assert.rejects(
            () => controller.compact(),
            ContextCompactUnavailableError,
        );
        assert.equal(controller.isBusy(), false);
    }

    const unknown = new Error("storage failed");
    const controller = bareController(
        {
            sessionId: "session-a",
            compact: () => Promise.reject(unknown),
        },
        [],
        { sendStatus: () => {} },
    );
    await assert.rejects(
        () => controller.compact(),
        (error) => error === unknown,
    );
});

/**
 * Purpose: Verify abort/queue operations cancel pending browser UI and emit the
 * authoritative empty queue/status updates expected by recovery clients.
 * Expect: Abort cancels before SDK abort; clearQueue emits one empty queue_update.
 * Method: Record call order and emitted events on a fake initialized session.
 */
Deno.test("PiSessionController aborts UI and clears queue with recovery events", async () => {
    const order: string[] = [];
    const events: ServerEvent[] = [];
    let statusCalls = 0;
    const controller = bareController(
        {
            sessionId: "session-a",
            abort: () => {
                order.push("abort");
                return Promise.resolve();
            },
            clearQueue: () => ({ steering: ["old"], followUp: ["old"] }),
        },
        events,
        {
            uiContext: { cancelAll: () => order.push("cancel") },
            sendStatus: () => statusCalls++,
        },
    );

    await controller.abort();
    await controller.clearQueue();

    assert.deepEqual(order, ["cancel", "abort"]);
    assert.equal(statusCalls, 2);
    assert.deepEqual(events, [{
        type: "queue_update",
        sessionId: "session-a",
        steering: [],
        followUp: [],
    }]);
});

/**
 * Purpose: Verify disposal orders extension/UI cleanup before SDK invalidation and
 * remains idempotent when multiple owners race teardown.
 * Expect: cancel → unsubscribe → session_shutdown → dispose occurs exactly once.
 * Method: Record each fake lifecycle hook and call dispose twice.
 */
Deno.test("PiSessionController disposes resources once in shutdown order", async () => {
    const order: string[] = [];
    const controller = bareController(
        {
            sessionId: "session-a",
            extensionRunner: {
                emit: () => {
                    order.push("shutdown");
                    return Promise.resolve();
                },
            },
            dispose: () => order.push("dispose"),
        },
        [],
        {
            uiContext: { cancelAll: () => order.push("cancel") },
            unsubscribe: () => order.push("unsubscribe"),
        },
    );

    await Promise.all([controller.dispose(), controller.dispose()]);
    await controller.dispose();

    assert.deepEqual(order, ["cancel", "unsubscribe", "shutdown", "dispose"]);
    assert.equal(controller.session, undefined);
});

/**
 * Purpose: Verify model/thinking changes apply immediately while idle, defer while
 * streaming, and unknown registry selections retain their typed client error.
 * Expect: Idle model mutates SDK; busy choices appear in pending model state.
 * Method: Toggle fake streaming state around setModel/setThinkingLevel calls.
 */
Deno.test("PiSessionController applies or defers model settings by workflow state", async () => {
    const current = testModel("current");
    const target = testModel("target");
    const later = testModel("later");
    let model = current;
    let thinkingLevel: ThinkingLevel = "off";
    let setModelCalls = 0;
    const session = {
        sessionId: "session-a",
        isStreaming: false,
        pendingMessageCount: 0,
        get model() {
            return model;
        },
        get thinkingLevel() {
            return thinkingLevel;
        },
        setModel: (next: typeof target) => {
            setModelCalls += 1;
            model = next;
            return Promise.resolve();
        },
        setThinkingLevel: (level: ThinkingLevel) => {
            thinkingLevel = level;
        },
        getAvailableThinkingLevels: () => ["off", "high"] as ThinkingLevel[],
    };
    const registry = {
        find: (_provider: string, id: string) =>
            [current, target, later].find((candidate) => candidate.id === id),
        getAvailable: () => [current, target, later],
    };
    const controller = bareController(session, [], { modelRegistry: registry });

    const applied = await controller.setModel("test", "target");
    assert.equal(applied.current?.id, "target");
    assert.equal(setModelCalls, 1);

    session.isStreaming = true;
    const pendingModel = await controller.setModel("test", "later");
    const pendingThinking = await controller.setThinkingLevel("high");
    assert.equal(setModelCalls, 1);
    assert.equal(pendingModel.pendingModel?.id, "later");
    assert.equal(pendingThinking.pendingThinkingLevel, "high");
    assert.equal(thinkingLevel, "off");

    await assert.rejects(
        () => controller.setModel("test", "missing"),
        UnknownModelError,
    );
});

/**
 * Purpose: Keep dormant and initialized model state aligned for persisted max thinking.
 * Expect: Both states restore max and advertise the same explicitly mapped levels.
 * Method: Compare a manager-context controller with a live fake session for one model.
 */
Deno.test("PiSessionController restores mapped max thinking consistently", () => {
    const model = {
        provider: "test",
        id: "reasoning",
        name: "Reasoning",
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    } as Parameters<typeof supportedThinkingLevels>[0];
    const levels = supportedThinkingLevels(model);
    const registry = {
        find: () => model,
        getAvailable: () => [model],
    };
    const dormant = bareController(undefined as never, [], {
        sessionResult: undefined,
        sessionManager: {
            getSessionId: () => "session-a",
            buildSessionContext: () => ({
                model: { provider: "test", modelId: "reasoning" },
                thinkingLevel: "max",
            }),
        },
        modelRegistry: registry,
    });
    const live = bareController(
        {
            sessionId: "session-a",
            model,
            thinkingLevel: "max",
            getAvailableThinkingLevels: () => levels,
        },
        [],
        { modelRegistry: registry },
    );

    assert.deepEqual(dormant.getModelState().availableThinkingLevels, levels);
    assert.equal(dormant.getModelState().thinkingLevel, "max");
    assert.deepEqual(dormant.getModelState(), live.getModelState());
});

/**
 * Purpose: Verify HTTP history caching is stable and revision seeding can only move
 * forward when workspace controller replacement invalidates old snapshots.
 * Expect: Repeated reads share identity; higher seed rebuilds; lower seed is ignored.
 * Method: Persist one turn in a real SessionManager and compare cached response objects.
 */
Deno.test("PiSessionController history cache follows monotonic revision seeds", async () => {
    const root = await Deno.makeTempDir();
    const cwd = join(root, "cwd");
    const manager = SessionManager.create(cwd, join(root, "sessions"));
    manager.appendMessage(testMessage("user", "question"));
    manager.appendMessage(testMessage("assistant", "answer"));
    const controller = new PiSessionController(
        cwd,
        join(root, "agent"),
        undefined as never,
        undefined as never,
        100,
        {
            createServices: () => Promise.reject(new Error("unused")),
            emit: () => {},
            onSessionMetadataChanged: () => {},
        },
    );
    controller.attachSessionManager(manager);

    try {
        const first = controller.getHistory();
        assert.equal(controller.getHistory(), first);
        assert.equal(first.revision, 0);
        assert.equal(first.messages.length, 2);

        controller.seedHistoryRevision(5);
        const seeded = controller.getHistory();
        assert.notEqual(seeded, first);
        assert.equal(seeded.revision, 5);

        controller.seedHistoryRevision(3);
        assert.equal(controller.getHistory(), seeded);
        assert.equal(controller.historyRevision(), 5);
    }
    finally {
        await controller.dispose();
        await Deno.remove(root, { recursive: true });
    }
});

function bareController(
    session: object,
    events: ServerEvent[],
    overrides: Record<string, unknown> = {},
) {
    const controller = Object.create(
        PiSessionController.prototype,
    ) as PiSessionController;
    Object.assign(controller, {
        sessionResult: { session },
        host: {
            emit: (event: ServerEvent) => events.push(event),
            onSessionMetadataChanged: () => {},
        },
        liveTurnMessages: new Map(),
        currentAssistantMessageId: "assistant-a",
        currentTextBlockId: undefined,
        currentThinkingBlockId: undefined,
        toolBlocks: new Map(),
        toolResultEmittedLength: new Map(),
        anonymousToolCallCounter: 0,
        anonymousToolCallId: undefined,
        pendingSettings: {},
        transcriptRevision: 0,
        compacting: false,
        disposing: false,
        disposed: false,
        modelRegistry: {
            find: () => undefined,
            getAvailable: () => [],
        },
        sendStatus: () => {},
        ...overrides,
    });
    return controller;
}

function testModel(id: string) {
    return {
        provider: "test",
        id,
        name: id,
        reasoning: false,
    };
}

function testMessage(role: "user" | "assistant", text: string) {
    return {
        role,
        content: [{ type: "text" as const, text }],
        timestamp: Date.now(),
    } as Parameters<SessionManager["appendMessage"]>[0];
}
