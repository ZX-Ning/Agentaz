import assert from "node:assert/strict";
import type { ServerEvent, ThinkingLevel } from "@agentaz/protocol";
import { PiSessionController } from "../src/pi/session-controller.ts";

type TestModel = {
    provider: string;
    id: string;
};

type SettingsTestController = {
    applyPendingSettingsIfIdle(): Promise<void>;
    pendingSettings: {
        model?: TestModel;
        thinkingLevel?: ThinkingLevel;
    };
};

/**
 * Purpose: Verify independently deferred model/thinking settings cannot cause one
 * failed SDK operation to discard or block the other requested setting.
 * Expect: Model remains pending, thinking applies, and one recoverable error is emitted.
 * Method: Seed both pending values, reject setModel before it mutates the fake
 * session, run the private idle apply path, then inspect pending state, thinking, and SSE.
 */
Deno.test("deferred model failure stays pending and does not block thinking", async () => {
    using errors = captureConsoleErrors();
    const targetModel = { provider: "test", id: "target" };
    const events: ServerEvent[] = [];
    let thinkingLevel: ThinkingLevel = "off";
    const session = {
        sessionId: "session-a",
        isStreaming: false,
        pendingMessageCount: 0,
        model: { provider: "test", id: "current" },
        get thinkingLevel() {
            return thinkingLevel;
        },
        setModel: () => Promise.reject(new Error("No API key")),
        setThinkingLevel: (level: ThinkingLevel) => {
            thinkingLevel = level;
        },
    };
    const controller = settingsController(
        session,
        { model: targetModel, thinkingLevel: "high" },
        events,
    );

    await assert.doesNotReject(() => controller.applyPendingSettingsIfIdle());

    assert.equal(controller.pendingSettings.model, targetModel);
    assert.equal(controller.pendingSettings.thinkingLevel, undefined);
    assert.equal(thinkingLevel, "high");
    assert.equal(errors.messages.length, 1);
    assert.deepEqual(events, [{
        type: "error",
        code: "settings_apply_failed",
        message: "Failed to apply pending model: No API key",
        recoverable: true,
    }]);
});

/**
 * Purpose: Verify asynchronous failure recovery preserves last-write-wins semantics
 * when the user selects another model while an older deferred apply is in flight.
 * Expect: The newer model remains pending after the older apply rejects.
 * Method: Start with model A pending, write model B from inside the fake asynchronous
 * setModel call, reject model A, then assert recovery leaves B rather than restoring A.
 */
Deno.test("deferred model failure preserves a newer pending request", async () => {
    using errors = captureConsoleErrors();
    const firstModel = { provider: "test", id: "first" };
    const newerModel = { provider: "test", id: "newer" };
    const events: ServerEvent[] = [];
    let controller: SettingsTestController;
    const session = {
        sessionId: "session-a",
        isStreaming: false,
        pendingMessageCount: 0,
        model: { provider: "test", id: "current" },
        thinkingLevel: "off" as ThinkingLevel,
        setModel: () => {
            controller.pendingSettings.model = newerModel;
            return Promise.reject(new Error("model hook failed"));
        },
        setThinkingLevel: () => {},
    };
    controller = settingsController(session, { model: firstModel }, events);

    await controller.applyPendingSettingsIfIdle();

    assert.equal(controller.pendingSettings.model, newerModel);
    assert.equal(errors.messages.length, 1);
    assert.equal(events.length, 1);
});

/**
 * Purpose: Avoid duplicate session entries and retry loops when the SDK mutates its
 * model successfully but a later extension/model-select hook rejects.
 * Expect: The target model is active and no pending model is restored.
 * Method: Make setModel assign the target before throwing, run deferred apply, and
 * compare live model identity with pending state and the emitted recoverable error.
 */
Deno.test("deferred model is not requeued when it applied before rejection", async () => {
    using errors = captureConsoleErrors();
    const targetModel = { provider: "test", id: "target" };
    const events: ServerEvent[] = [];
    const session = {
        sessionId: "session-a",
        isStreaming: false,
        pendingMessageCount: 0,
        model: { provider: "test", id: "current" },
        thinkingLevel: "off" as ThinkingLevel,
        async setModel(model: TestModel) {
            this.model = model;
            throw new Error("model hook failed");
        },
        setThinkingLevel: () => {},
    };
    const controller = settingsController(
        session,
        { model: targetModel },
        events,
    );

    await controller.applyPendingSettingsIfIdle();

    assert.equal(controller.pendingSettings.model, undefined);
    assert.equal(errors.messages.length, 1);
    assert.equal(events.length, 1);
});

function settingsController(
    session: object,
    pendingSettings: SettingsTestController["pendingSettings"],
    events: ServerEvent[],
) {
    const controller = Object.create(
        PiSessionController.prototype,
    ) as SettingsTestController;
    Object.assign(controller, {
        sessionResult: { session },
        pendingSettings,
        compacting: false,
        disposing: false,
        disposed: false,
        host: {
            emit: (event: ServerEvent) => events.push(event),
        },
    });
    return controller;
}

function captureConsoleErrors() {
    const original = console.error;
    const messages: unknown[][] = [];
    console.error = (...args: unknown[]) => messages.push(args);
    return {
        messages,
        [Symbol.dispose]() {
            console.error = original;
        },
    };
}
