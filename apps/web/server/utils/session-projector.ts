import type {
    AgentCapabilities,
    AgentStateResponse,
    ServerHello,
    UiLoadedSession,
    UiRuntimeLoadedSession,
} from "../../types/protocol";
import { PROTOCOL_VERSION } from "../../types/protocol";
import type { ClientPresence } from "./client-presence";
import type { PiSessionWorkspace } from "./pi-session-workspace";

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

/**
 * Returns the current state snapshot for one browser client.
 * Client-specific fields: active session + session control ownership flags.
 */
export function getAgentState(
    workspace: PiSessionWorkspace,
    presence: ClientPresence,
    clientId: string,
): AgentStateResponse {
    return {
        protocolVersion: PROTOCOL_VERSION,
        cwd: workspace.cwd,
        activeSessionId: presence.activeFor(clientId),
        loadedSessions: getLoadedSessionsForClient(
            workspace,
            presence,
            clientId,
        ),
        persistedSessions: workspace.persistedSessions,
        capabilities: CAPABILITIES,
    };
}

/** Returns the first SSE payload sent to a newly attached browser client. */
export function createServerHello(
    workspace: PiSessionWorkspace,
    presence: ClientPresence,
    clientId: string,
): ServerHello {
    return {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        cwd: workspace.cwd,
        clientId,
        state: getAgentState(workspace, presence, clientId),
    };
}

/** Projects runtime loaded sessions into one client's browser-facing rows. */
function getLoadedSessionsForClient(
    workspace: PiSessionWorkspace,
    presence: ClientPresence,
    clientId: string,
): UiLoadedSession[] {
    return workspace.loadedSessions().map((session: UiRuntimeLoadedSession) => {
        const controlOwnerClientId = presence.ownerOf(session.sessionId);
        return {
            ...session,
            controlOwnerClientId,
            controlledByCurrentClient: controlOwnerClientId === clientId,
        };
    });
}
