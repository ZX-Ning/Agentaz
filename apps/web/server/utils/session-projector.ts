import type {
  AgentCapabilities,
  AgentStateResponse,
  ServerHello,
  UiLoadedSession,
} from "../../types/protocol";
import { PROTOCOL_VERSION } from "../../types/protocol";
import type { ClientPresence } from "./client-presence";
import type { PiSessionWorkspace } from "./pi-session-workspace";

const CAPABILITIES: AgentCapabilities = {
  steer: true,
  followUp: true,
  clearQueue: true,
  permissions: true,
  modelSelect: true,
  thinkingSelect: true,
  images: false,
  fileTree: false,
  diffViewer: false,
};

/**
 * Builds browser-facing snapshots from session runtime state and client presence state.
 *
 * Projection is separated from both Pi SDK lifecycle and WebSocket peer management so each client
 * can receive a client-specific view without coupling those services together.
 */
export class SessionProjector {
  constructor(
    private readonly workspace: PiSessionWorkspace,
    private readonly presence: ClientPresence,
  ) {}

  /** Refreshes backing data used by state snapshots that is not continuously loaded. */
  async refresh() {
    await this.workspace.refreshPersistedSessionCache();
  }

  /** Returns the current HTTP/WS state snapshot for a specific client. */
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

  /** Returns the WebSocket hello payload for a newly attached client. */
  hello(clientId: string): ServerHello {
    return {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      cwd: this.workspace.cwd,
      clientId,
      state: this.getState(clientId),
    };
  }

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
