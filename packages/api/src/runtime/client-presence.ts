import { SessionControlConflictError } from "../errors.ts";

export const LOCAL_CLIENT_ID = "local-browser";

/** Public view of a session control lease. */
export type SessionControlState = {
    sessionId: string;
    controlOwnerClientId?: string;
};

/** Presence data tracked per browser client identity. */
type ClientPresenceRecord = {
    /** The session currently focused by this client. */
    activeSessionId?: string;
};

/** Re-entrant mutation control lease for one session. */
type SessionControlLease = {
    /** Client currently allowed to mutate the session. */
    ownerClientId: string;
    /** Nested acquireControl count held by ownerClientId. */
    holdCount: number;
};

/**
 * Process singleton presence tracker owned by AgentRuntime.
 * Stores client focus + re-entrant session control leases; no Pi/SSE deps.
 */
export class ClientPresence {
    /** clientId → presence record for currently connected browser clients. */
    private clientsById = new Map<string, ClientPresenceRecord>();
    /** sessionId → mutation control lease for that session. */
    private controlLeasesBySession = new Map<string, SessionControlLease>();
    private lastActiveSessionId?: string;

    /** Registers a connected browser client and gives it a sensible active session default. */
    attachClient(clientId: string, fallbackSessionId?: string) {
        const activeSessionId = this.lastActiveSessionId ?? fallbackSessionId;
        this.clientsById.set(clientId, { activeSessionId });
    }

    /** Removes a browser client, releases its control leases, and returns changed session ids. */
    detachClient(clientId: string) {
        this.clientsById.delete(clientId);
        const changedSessionIds: string[] = [];
        for (
            const [sessionId, lease] of this.controlLeasesBySession
        ) {
            if (lease.ownerClientId === clientId) {
                this.controlLeasesBySession.delete(sessionId);
                changedSessionIds.push(sessionId);
            }
        }
        return changedSessionIds;
    }

    /** Focuses one session for a single client identity. */
    focus(clientId: string, sessionId: string) {
        this.lastActiveSessionId = sessionId;
        this.clientsById.set(clientId, { activeSessionId: sessionId });
    }

    /** Acquires mutation control for a session unless a different client already owns it. */
    acquireControl(clientId: string, sessionId: string) {
        const lease = this.controlLeasesBySession.get(sessionId);
        if (lease && lease.ownerClientId !== clientId) {
            throw new SessionControlConflictError();
        }
        this.controlLeasesBySession.set(sessionId, {
            ownerClientId: clientId,
            holdCount: (lease?.holdCount ?? 0) + 1,
        });
    }

    /** Releases mutation control for a session if the given client owns it. */
    releaseControl(clientId: string, sessionId: string) {
        const lease = this.controlLeasesBySession.get(sessionId);
        if (lease?.ownerClientId !== clientId) {
            return;
        }
        const nextCount = lease.holdCount - 1;
        if (nextCount > 0) {
            this.controlLeasesBySession.set(sessionId, {
                ...lease,
                holdCount: nextCount,
            });
        }
        else {
            this.controlLeasesBySession.delete(sessionId);
        }
    }

    /** Returns the active session visible to one client. */
    activeFor(clientId: string) {
        return (
            this.clientsById.get(clientId)?.activeSessionId ??
                this.lastActiveSessionId
        );
    }

    /** Returns the client that currently owns a session control lease, if any. */
    ownerOf(sessionId: string) {
        return this.controlLeasesBySession.get(sessionId)?.ownerClientId;
    }

    /** Returns all currently connected browser client ids. */
    clients() {
        return [...this.clientsById.keys()];
    }

    /** Returns all current control leases. */
    controls(): SessionControlState[] {
        return [...this.controlLeasesBySession].map(
            ([sessionId, lease]) => ({
                sessionId,
                controlOwnerClientId: lease.ownerClientId,
            }),
        );
    }

    /** Removes stale active/control references for a session that has been
     *  evicted, deleted, or disposed from the workspace. */
    removeSession(sessionId: string, fallbackSessionId?: string) {
        this.controlLeasesBySession.delete(sessionId);
        for (
            const [clientId, client] of this.clientsById
        ) {
            if (client.activeSessionId !== sessionId) {
                continue;
            }
            if (fallbackSessionId) {
                this.clientsById.set(clientId, {
                    ...client,
                    activeSessionId: fallbackSessionId,
                });
            }
            else {
                this.clientsById.set(clientId, {
                    ...client,
                    activeSessionId: undefined,
                });
            }
        }
        if (this.lastActiveSessionId === sessionId) {
            this.lastActiveSessionId = fallbackSessionId;
        }
    }
}
