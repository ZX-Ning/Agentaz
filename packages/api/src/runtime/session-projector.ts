import type {
    AgentCapabilities,
    AgentStateResponse,
    ServerHello,
    UiLoadedSession,
    UiRuntimeLoadedSession,
    UiSessionSummary,
} from "@agentaz/protocol";
import { PROTOCOL_VERSION } from "@agentaz/protocol";
import type { ClientPresence } from "./client-presence.ts";
import type { PiSessionWorkspace } from "../pi/session-workspace.ts";

/**
 * Declared backend capabilities advertised to the browser on connect.
 *
 * These flags tell the frontend which features are supported by this
 * backend version. Features with `false` are not yet implemented in the
 * web UI context (e.g. image uploads, file tree, diff viewer).
 */
const CAPABILITIES: AgentCapabilities = {
    steer: true,
    followUp: true,
    clearQueue: true,
    permissions: true,
    modelSelect: true,
    thinkingSelect: true,
    sessionFork: true,
    sessionRevert: true,
    contextCompact: true,
    /** Image attachments reserved for future multimodal support. */
    images: false,
    /** File tree browser not implemented in the web MVP. */
    fileTree: false,
    /** Side-by-side diff viewer not implemented in the web MVP. */
    diffViewer: false,
};

/** Refreshes persisted data used by browser-facing state snapshots. */
export async function refreshProjectionData(workspace: PiSessionWorkspace) {
    await workspace.refreshPersistedSessionCache();
}

/** Expensive client-independent data reused within one snapshot broadcast. */
export type SharedAgentStateProjection = {
    loadedSessions: UiRuntimeLoadedSession[];
    persistedSessions: UiSessionSummary[];
};

/** Computes one fresh shared projection; callers must not retain it across events. */
export function createSharedAgentStateProjection(
    workspace: PiSessionWorkspace,
): SharedAgentStateProjection {
    return {
        loadedSessions: workspace.loadedSessions(),
        persistedSessions: workspace.persistedSessions,
    };
}

/**
 * Returns the current state snapshot for one browser client.
 * Client-specific fields: active session + session control ownership flags.
 */
export function getAgentState(
    workspace: PiSessionWorkspace,
    presence: ClientPresence,
    clientId: string,
    shared = createSharedAgentStateProjection(workspace),
): AgentStateResponse {
    return {
        protocolVersion: PROTOCOL_VERSION,
        cwd: workspace.cwd,
        activeSessionId: presence.activeFor(clientId),
        loadedSessions: getLoadedSessionsForClient(
            shared.loadedSessions,
            presence,
            clientId,
        ),
        persistedSessions: shared.persistedSessions,
        capabilities: CAPABILITIES,
    };
}

/** Returns the first SSE payload sent to a newly attached browser client. */
export function createServerHello(
    workspace: PiSessionWorkspace,
    presence: ClientPresence,
    clientId: string,
    shared = createSharedAgentStateProjection(workspace),
): ServerHello {
    return {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        cwd: workspace.cwd,
        clientId,
        state: getAgentState(workspace, presence, clientId, shared),
    };
}

/** Projects runtime loaded sessions into one client's browser-facing rows. */
function getLoadedSessionsForClient(
    loadedSessions: UiRuntimeLoadedSession[],
    presence: ClientPresence,
    clientId: string,
): UiLoadedSession[] {
    return loadedSessions.map(
        (session: UiRuntimeLoadedSession) => {
            const controlOwnerClientId = presence.ownerOf(session.sessionId);
            return {
                ...session,
                controlOwnerClientId,
                controlledByCurrentClient: controlOwnerClientId === clientId,
            };
        },
    );
}
