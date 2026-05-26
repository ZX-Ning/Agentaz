import type {
  AgentCapabilities,
  AgentStateResponse,
  ServerHello,
  UiLoadedSession,
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
  /** Image attachments reserved for future multimodal support. */
  images: false,
  /** File tree browser not implemented in the web MVP. */
  fileTree: false,
  /** Side-by-side diff viewer not implemented in the web MVP. */
  diffViewer: false,
};

/**
 * Builds browser-facing snapshots from session runtime state and client presence state.
 *
 * Projection is separated from both Pi SDK lifecycle and WebSocket peer management
 * so each client can receive a client-specific view without coupling those services
 * together. This means:
 *   - The workspace doesn't need to know which clients are connected.
 *   - The presence service doesn't need to know about session internals.
 *   - Each client sees its own active session, plus control ownership for all sessions.
 */
export class SessionProjector {
  constructor(
    private readonly workspace: PiSessionWorkspace,
    private readonly presence: ClientPresence,
  ) {}

  /**
   * Refreshes backing data used by state snapshots that is not continuously loaded.
   *
   * Currently this only refreshes the persisted session cache — loaded session data
   * is already live through the workspace's in-memory working set.
   */
  async refresh() {
    await this.workspace.refreshPersistedSessionCache();
  }

  /**
   * Returns the current HTTP/WS state snapshot for a specific browser client.
   *
   * The snapshot is client-specific because:
   *   - activeSessionId depends on which session this client has focused.
   *   - loadedSessions includes controlOwnerClientId and controlledByCurrentClient
   *     flags that differ per client.
   */
  getState(clientId: string): AgentStateResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      cwd: this.workspace.cwd,
      activeSessionId: this.presence.activeFor(clientId),
      loadedSessions: this.loadedSessionsFor(clientId),
      persistedSessions: this.workspace.persistedSessions,
      capabilities: CAPABILITIES,
    };
  }

  /**
   * Returns the WebSocket hello payload for a newly attached client.
   * This is the very first message sent after a WebSocket connection is established.
   * It declares protocol version, assigns a client id, and includes the full state
   * snapshot so the frontend can render immediately.
   */
  hello(clientId: string): ServerHello {
    return {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      cwd: this.workspace.cwd,
      clientId,
      state: this.getState(clientId),
    };
  }

  /**
   * Augments each loaded session with control ownership metadata for a specific client.
   * Two fields are added:
   *   - controlOwnerClientId: Which client (if any) currently holds the mutation lease.
   *   - controlledByCurrentClient: Whether this specific client is the control owner.
   */
  private loadedSessionsFor(clientId: string): UiLoadedSession[] {
    return this.workspace.loadedSessions().map((session) => {
      const controlOwnerClientId = this.presence.ownerOf(session.sessionId);
      return {
        ...session,
        controlOwnerClientId,
        controlledByCurrentClient: controlOwnerClientId === clientId,
      };
    });
  }
}
