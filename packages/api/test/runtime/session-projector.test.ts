import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@agentaz/protocol";
import type { UiRuntimeLoadedSession } from "@agentaz/protocol";
import type { PiSessionWorkspace } from "../../src/pi/session-workspace.ts";
import { ClientPresence } from "../../src/runtime/client-presence.ts";
import {
    createServerHello,
    createSharedAgentStateProjection,
    getAgentState,
    refreshProjectionData,
} from "../../src/runtime/session-projector.ts";

/**
 * Purpose: Verify one shared workspace produces client-specific focus and control
 * projections without changing the underlying loaded-session state.
 * Expect: Each client sees its own active/control flags and the shared protocol/capabilities.
 * Method: Focus and acquire different sessions for two clients, then compare snapshots.
 */
Deno.test("session projector builds client-specific state snapshots", () => {
    const workspace = fakeWorkspace([
        loadedSession("session-a"),
        loadedSession("session-b"),
    ]);
    const presence = new ClientPresence();
    presence.focus("client-a", "session-a");
    presence.focus("client-b", "session-b");
    presence.acquireControl("client-a", "session-a");

    const shared = createSharedAgentStateProjection(workspace);
    const stateA = getAgentState(workspace, presence, "client-a", shared);
    const stateB = getAgentState(workspace, presence, "client-b", shared);

    assert.equal(stateA.protocolVersion, PROTOCOL_VERSION);
    assert.equal(stateA.cwd, "/workspace");
    assert.equal(stateA.activeSessionId, "session-a");
    assert.equal(stateB.activeSessionId, "session-b");
    assert.equal(stateA.capabilities.contextCompact, true);
    assert.equal(stateA.capabilities.images, false);

    const sessionAForA = stateA.loadedSessions.find((item) =>
        item.sessionId === "session-a"
    );
    const sessionAForB = stateB.loadedSessions.find((item) =>
        item.sessionId === "session-a"
    );
    assert.equal(sessionAForA?.controlOwnerClientId, "client-a");
    assert.equal(sessionAForA?.controlledByCurrentClient, true);
    assert.equal(sessionAForB?.controlOwnerClientId, "client-a");
    assert.equal(sessionAForB?.controlledByCurrentClient, false);
    assert.equal(workspaceProjectionCalls(workspace), 1);
});

/**
 * Purpose: Verify hello embeds the same authoritative state projection and refresh
 * delegates to the workspace before transport code takes a snapshot.
 * Expect: Hello identifies the client and refresh invokes persisted-cache loading once.
 * Method: Refresh a fake workspace, create hello, and compare protocol/client/state fields.
 */
Deno.test("session projector refreshes data and creates server hello", async () => {
    let refreshCalls = 0;
    const workspace = fakeWorkspace([loadedSession("session-a")], () => {
        refreshCalls += 1;
    });
    const presence = new ClientPresence();
    presence.attachClient("client-a", "session-a");

    await refreshProjectionData(workspace);
    const hello = createServerHello(workspace, presence, "client-a");

    assert.equal(refreshCalls, 1);
    assert.equal(hello.type, "hello");
    assert.equal(hello.protocolVersion, PROTOCOL_VERSION);
    assert.equal(hello.clientId, "client-a");
    assert.equal(hello.state.activeSessionId, "session-a");
    assert.equal(hello.state.loadedSessions[0]?.sessionId, "session-a");
});

function fakeWorkspace(
    sessions: UiRuntimeLoadedSession[],
    refresh: () => void = () => {},
) {
    let projectionCalls = 0;
    const workspace = {
        cwd: "/workspace",
        persistedSessions: [{
            file: "/workspace/session-a.jsonl",
            sessionId: "session-a",
            name: "Session A",
            createdAt: 1,
            updatedAt: 2,
        }],
        loadedSessions: () => {
            projectionCalls += 1;
            return sessions;
        },
        refreshPersistedSessionCache: () => {
            refresh();
            return Promise.resolve();
        },
    } as unknown as PiSessionWorkspace;
    projectionCallsByWorkspace.set(workspace, () => projectionCalls);
    return workspace;
}

const projectionCallsByWorkspace = new WeakMap<
    PiSessionWorkspace,
    () => number
>();

function workspaceProjectionCalls(workspace: PiSessionWorkspace) {
    return projectionCallsByWorkspace.get(workspace)?.() ?? 0;
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
