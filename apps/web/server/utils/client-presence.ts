import { SessionControlConflictError } from "./domain-errors";

export const LOCAL_CLIENT_ID = "local-browser";

/** Public view of a session control lease. */
export type SessionControlState = {
  sessionId: string;
  controlOwnerClientId?: string;
};

/**
 * Tracks browser client presence, per-client focus, and session control leases.
 *
 * This service is intentionally independent from WebSocket peers and Pi SDK controllers. It only
 * stores client ids and session ids so session lifecycle code can stay transport-agnostic.
 */
export class ClientPresence {
  private connectedClients = new Set<string>();
  private activeSessionByClient = new Map<string, string>();
  private controlOwnerBySession = new Map<string, string>();
  private controlHoldCountBySession = new Map<string, number>();
  private lastActiveSessionId?: string;

  /** Registers a connected browser client and gives it a sensible active session default. */
  attachClient(clientId: string, fallbackSessionId?: string) {
    this.connectedClients.add(clientId);
    const activeSessionId = this.lastActiveSessionId ?? fallbackSessionId;
    if (activeSessionId) {
      this.activeSessionByClient.set(clientId, activeSessionId);
    }
  }

  /** Removes a browser client, releases its control leases, and returns changed session ids. */
  detachClient(clientId: string) {
    this.connectedClients.delete(clientId);
    this.activeSessionByClient.delete(clientId);
    const changedSessionIds: string[] = [];
    for (const [sessionId, ownerClientId] of this.controlOwnerBySession) {
      if (ownerClientId !== clientId) continue;
      this.controlOwnerBySession.delete(sessionId);
      this.controlHoldCountBySession.delete(sessionId);
      changedSessionIds.push(sessionId);
    }
    return changedSessionIds;
  }

  /** Focuses one session for a single client identity. */
  focus(clientId: string, sessionId: string) {
    this.lastActiveSessionId = sessionId;
    this.activeSessionByClient.set(clientId, sessionId);
  }

  /** Acquires mutation control for a session unless a different client already owns it. */
  acquireControl(clientId: string, sessionId: string) {
    const ownerClientId = this.controlOwnerBySession.get(sessionId);
    if (ownerClientId && ownerClientId !== clientId) {
      throw new SessionControlConflictError();
    }
    this.controlOwnerBySession.set(sessionId, clientId);
    this.controlHoldCountBySession.set(
      sessionId,
      (this.controlHoldCountBySession.get(sessionId) ?? 0) + 1,
    );
  }

  /** Releases mutation control for a session if the given client owns it. */
  releaseControl(clientId: string, sessionId: string) {
    if (this.controlOwnerBySession.get(sessionId) !== clientId) return;
    const nextCount = (this.controlHoldCountBySession.get(sessionId) ?? 1) - 1;
    if (nextCount > 0) {
      this.controlHoldCountBySession.set(sessionId, nextCount);
      return;
    }
    this.controlHoldCountBySession.delete(sessionId);
    this.controlOwnerBySession.delete(sessionId);
  }

  /** Returns the active session visible to one client. */
  activeFor(clientId: string) {
    return this.activeSessionByClient.get(clientId) ?? this.lastActiveSessionId;
  }

  /** Returns the client that currently owns a session control lease, if any. */
  ownerOf(sessionId: string) {
    return this.controlOwnerBySession.get(sessionId);
  }

  /** Returns all currently connected browser client ids. */
  clients() {
    return [...this.connectedClients];
  }

  /** Returns all current control leases. */
  controls(): SessionControlState[] {
    return [...this.controlOwnerBySession].map(
      ([sessionId, controlOwnerClientId]) => ({
        sessionId,
        controlOwnerClientId,
      }),
    );
  }

  /** Removes stale active/control references after a session leaves the workspace. */
  removeSession(sessionId: string, fallbackSessionId?: string) {
    this.controlOwnerBySession.delete(sessionId);
    this.controlHoldCountBySession.delete(sessionId);
    for (const [clientId, activeSessionId] of this.activeSessionByClient) {
      if (activeSessionId === sessionId) {
        if (fallbackSessionId) {
          this.activeSessionByClient.set(clientId, fallbackSessionId);
        } else {
          this.activeSessionByClient.delete(clientId);
        }
      }
    }
    if (this.lastActiveSessionId === sessionId) {
      this.lastActiveSessionId = fallbackSessionId;
    }
  }
}
