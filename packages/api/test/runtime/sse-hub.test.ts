import assert from "node:assert/strict";
import type { ServerEvent, UiRuntimeLoadedSession } from "@agentaz/protocol";
import type { PiSessionWorkspace } from "../../src/pi/session-workspace.ts";
import { AgentEventBus } from "../../src/runtime/event-bus.ts";
import { ClientPresence } from "../../src/runtime/client-presence.ts";
import { SseAgentHub } from "../../src/runtime/sse-hub.ts";

/**
 * Purpose: Verify connection setup refreshes projection data and establishes the
 * documented first-loaded fallback before sending initial recovery payloads.
 * Expect: Hello precedes snapshot and both identify session-a as active.
 * Method: Open one client against a one-session workspace, decode writes, then close.
 */
Deno.test("SseAgentHub opens with hello, snapshot, and loaded-session fallback", async () => {
    const eventBus = new AgentEventBus();
    const presence = new ClientPresence();
    const workspace = fakeWorkspace([loadedSession("session-a")]);
    const hub = new SseAgentHub(eventBus, workspace.value, presence);
    const events: ServerEvent[] = [];

    await hub.open("client-a", (data) => events.push(JSON.parse(data)));

    assert.deepEqual(events.map((event) => event.type), [
        "hello",
        "state_snapshot",
    ]);
    assert.equal(events[0]?.type, "hello");
    if (events[0]?.type === "hello") {
        assert.equal(events[0].clientId, "client-a");
        assert.equal(events[0].state.activeSessionId, "session-a");
    }
    assert.equal(presence.activeFor("client-a"), "session-a");
    assert.equal(workspace.refreshCalls(), 1);

    hub.close("client-a");
    assert.deepEqual(presence.clients(), []);
});

/**
 * Purpose: Verify runtime events reach every healthy client while transport
 * failures remain isolated and disconnect releases control without unloading sessions.
 * Expect: Both clients receive server/control events; one throwing sender cannot block the other.
 * Method: Open two clients, publish events, force one sender failure, and disconnect its owner.
 */
Deno.test("SseAgentHub broadcasts events and releases disconnected control", async () => {
    using errors = captureConsoleErrors();
    const eventBus = new AgentEventBus();
    const presence = new ClientPresence();
    const workspace = fakeWorkspace([
        loadedSession("session-a"),
        loadedSession("session-b"),
    ]);
    const hub = new SseAgentHub(eventBus, workspace.value, presence);
    const eventsA: ServerEvent[] = [];
    const eventsB: ServerEvent[] = [];
    let failB = false;

    await hub.open("client-a", (data) => eventsA.push(JSON.parse(data)));
    await hub.open("client-b", (data) => {
        if (failB) {
            throw new Error("stale stream");
        }
        eventsB.push(JSON.parse(data));
    });

    presence.acquireControl("client-a", "session-a");
    presence.acquireControl("client-a", "session-b");
    eventBus.publish({
        type: "control_changed",
        sessionId: "session-a",
        controlOwnerClientId: "client-a",
    });
    assert.ok(eventsA.some((event) =>
        event.type === "control_changed" &&
        event.controlOwnerClientId === "client-a"
    ));
    assert.ok(eventsB.some((event) =>
        event.type === "state_snapshot" &&
        event.state.loadedSessions.find((session) =>
                session.sessionId === "session-a"
            )?.controlledByCurrentClient === false
    ));

    failB = true;
    eventBus.publish({
        type: "server_event",
        event: {
            type: "ui_notify",
            sessionId: "session-a",
            message: "notice",
        },
    });
    assert.ok(
        eventsA.some((event) =>
            event.type === "ui_notify" && event.message === "notice"
        ),
    );
    assert.equal(errors.messages.length, 1);

    failB = false;
    const beforeCloseB = eventsB.length;
    hub.close("client-a");
    assert.equal(presence.ownerOf("session-a"), undefined);
    assert.equal(presence.ownerOf("session-b"), undefined);
    assert.ok(
        eventsB.slice(beforeCloseB).some((event) =>
            event.type === "control_changed" && event.sessionId === "session-a"
        ),
    );
    assert.ok(
        eventsB.slice(beforeCloseB).some((event) =>
            event.type === "control_changed" && event.sessionId === "session-b"
        ),
    );

    hub.close("client-b");
    assert.equal(workspace.disposeCalls(), 0);
});

/**
 * Purpose: Verify a route disconnect observed during asynchronous refresh prevents
 * stale hello/snapshot writes and does not leave the heartbeat running.
 * Expect: The cancelled open sends nothing and removes the client from presence.
 * Method: Block refresh, close immediately, release refresh, then reopen successfully.
 */
Deno.test("SseAgentHub ignores an open that disconnects during refresh", async () => {
    const refresh = Promise.withResolvers<void>();
    const eventBus = new AgentEventBus();
    const presence = new ClientPresence();
    const workspace = fakeWorkspace(
        [loadedSession("session-a")],
        () => refresh.promise,
    );
    const hub = new SseAgentHub(eventBus, workspace.value, presence);
    const cancelledEvents: ServerEvent[] = [];

    const opening = hub.open(
        "client-a",
        (data) => cancelledEvents.push(JSON.parse(data)),
    );
    hub.close("client-a");
    refresh.resolve();
    await opening;

    assert.deepEqual(cancelledEvents, []);
    assert.deepEqual(presence.clients(), []);

    const reopenedEvents: ServerEvent[] = [];
    await hub.open("client-b", (data) => reopenedEvents.push(JSON.parse(data)));
    assert.deepEqual(reopenedEvents.map((event) => event.type), [
        "hello",
        "state_snapshot",
    ]);
    hub.close("client-b");
});

function fakeWorkspace(
    sessions: UiRuntimeLoadedSession[],
    refresh: () => Promise<void> = () => Promise.resolve(),
) {
    let refreshCount = 0;
    let disposed = 0;
    const value = {
        cwd: "/workspace",
        persistedSessions: [],
        loadedSessions: () => sessions,
        firstLoadedSessionId: () => sessions[0]?.sessionId,
        refreshPersistedSessionCache: async () => {
            refreshCount += 1;
            await refresh();
        },
        disposeAll: () => {
            disposed += 1;
            return Promise.resolve();
        },
    } as unknown as PiSessionWorkspace;
    return {
        value,
        refreshCalls: () => refreshCount,
        disposeCalls: () => disposed,
    };
}

function loadedSession(sessionId: string): UiRuntimeLoadedSession {
    return {
        file: `/workspace/${sessionId}.jsonl`,
        sessionId,
        sessionFile: `/workspace/${sessionId}.jsonl`,
        name: sessionId,
        createdAt: 1,
        updatedAt: 2,
        isWorking: false,
        isStreaming: false,
        pendingMessageCount: 0,
        pendingApprovalCount: 0,
        pendingUiRequests: [],
        extensionWidgets: [],
    };
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
