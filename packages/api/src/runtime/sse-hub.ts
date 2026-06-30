import type { ServerEvent } from "@agentaz/protocol";
import type { AgentEventBus, AgentRuntimeEvent } from "./event-bus.ts";
import type { ClientPresence } from "./client-presence.ts";
import type { PiSessionWorkspace } from "../pi/session-workspace.ts";
import {
    createServerHello,
    getAgentState,
    refreshProjectionData,
} from "./session-projector.ts";

/** Sends one serialized SSE payload to a connected browser client. */
export type SseSend = (data: string) => void;

/**
 * Process singleton SSE hub owned by AgentRuntime.
 * Owns client registration + event forwarding; never owns Pi session lifecycle.
 * SSE detach != session abort/dispose. Heartbeat snapshots run every 15s.
 */
export class SseAgentHub {
    /** Active SSE send functions indexed by clientId. */
    private senders = new Map<string, SseSend>();
    /** Periodic state snapshot heartbeat interval (15s). */
    private heartbeat?: NodeJS.Timeout;
    /** Cleanup function for the AgentEventBus subscription. */
    private unsubscribe?: () => void;

    constructor(
        private readonly eventBus: AgentEventBus,
        private readonly workspace: PiSessionWorkspace,
        private readonly presence: ClientPresence,
    ) {}

    /**
     * Registers a new SSE client and sends the initial handshake + snapshot.
     *
     * Lifecycle on connect:
     *   1. Register the send function.
     *   2. Attach to ClientPresence so the new client gets a default active session.
     *   3. Refresh persisted session data.
     *   4. Push the hello payload (protocol version + full state snapshot).
     *   5. Push a targeted state snapshot to this client.
     *   6. Start the event bus subscription (lazy, only on first client).
     *   7. Start the 15s heartbeat.
     *
     * @param clientId - Stable client identifier (crypto.randomUUID).
     * @param send     - Serialized SSE payload sink.
     */
    async open(clientId: string, send: SseSend) {
        // Phase 1: store the sender so broadcast/write can reach it.
        this.senders.set(clientId, send);

        // Phase 2: register this client in presence tracking so it gets a sensible
        // default active session (last active session from any client, or
        // the first loaded session as fallback).
        this.presence.attachClient(clientId);

        // Phase 3: refresh persisted session cache so the snapshot is current.
        await refreshProjectionData(this.workspace);

        // The route may observe disconnect while refresh is awaiting.
        if (this.senders.get(clientId) !== send) return;

        // Phase 4: send the initial hello + targeted state snapshot.
        this.pushSafely(
            send,
            JSON.stringify(
                createServerHello(this.workspace, this.presence, clientId),
            ),
        );
        this.writeStateSnapshot(clientId, send);

        // Phase 5: lazy subscription — only subscribe to the event bus when at
        // least one browser client is connected.
        this.startEventSubscription();

        // Phase 6: start periodic state snapshots to keep the frontend in sync.
        this.ensureHeartbeat();
    }

    /** Detaches a browser client after the route observes EventStream.onClosed. */
    close(clientId: string) {
        this.handleDisconnect(clientId);
    }

    /**
     * Detaches a browser client without aborting or disposing loaded Pi sessions.
     *
     * On disconnect:
     *   1. Remove the send function from the active client map.
     *   2. Detach from ClientPresence — this releases any control leases the
     *      client held and returns the list of affected session ids.
     *   3. Broadcast control_changed for each affected session (so other
     *      connected clients see the updated control ownership).
     *   4. Broadcast state snapshots to all remaining clients.
     *   5. Stop the heartbeat if no clients remain connected.
     */
    private handleDisconnect(clientId: string) {
        if (!this.senders.has(clientId)) return;

        this.senders.delete(clientId);

        // Detach from presence: releases control leases and returns
        // session ids whose control state changed.
        const changedSessionIds = this.presence.detachClient(clientId);
        for (const sessionId of changedSessionIds) {
            this.broadcastControl(sessionId);
        }

        // Refresh all remaining clients with updated state.
        this.broadcastStateSnapshots();

        // Stop the heartbeat timer when no clients are connected.
        if (this.senders.size === 0) this.stopHeartbeat();
    }

    /**
     * Starts the AgentEventBus subscription (idempotent).
     * Only subscribes once regardless of how many clients connect.
     */
    private startEventSubscription() {
        if (this.unsubscribe) return;
        this.unsubscribe = this.eventBus.subscribe(event =>
            this.handleRuntimeEvent(event),
        );
    }

    /**
     * Routes AgentRuntimeEvents to the appropriate broadcast method.
     *
     * Event routing:
     *   - server_event: Direct broadcast of the contained ServerEvent to all clients.
     *   - control_changed: Broadcast a control_changed event + full state snapshots
     *     so the frontend can update both the control indicator and session state.
     *   - session_removed: Handled by ClientPresence via the runtime subscription
     *     (not forwarded to clients — the presence update triggers state snapshots).
     *   - state_changed: Broadcast full state snapshots to all clients.
     */
    private handleRuntimeEvent(event: AgentRuntimeEvent) {
        switch (event.type) {
            case "server_event":
                // Direct forward: session events (streaming deltas, tool calls, etc.)
                // are broadcast as-is to all connected browser clients.
                this.broadcast(event.event);
                break;
            case "control_changed":
                this.broadcast({
                    type: "control_changed",
                    sessionId: event.sessionId,
                    controlOwnerClientId: event.controlOwnerClientId,
                });
                this.broadcastStateSnapshots();
                break;
            case "session_removed":
                // Session removal is handled by the ClientPresence subscription
                // in agent-runtime.ts. We don't forward it because state snapshots
                // will reflect the removed session.
                break;
            default:
                // state_changed and any future event types → full state snapshot.
                this.broadcastStateSnapshots();
                break;
        }
    }

    /** Sends a state_snapshot event to all connected browser clients. */
    private broadcastStateSnapshots() {
        for (const [clientId, send] of this.senders) {
            this.writeStateSnapshot(clientId, send);
        }
    }

    /** Sends a state_snapshot event targeted to one specific client. */
    private writeStateSnapshot(clientId: string, send: SseSend) {
        this.pushSafely(
            send,
            JSON.stringify({
                type: "state_snapshot",
                state: getAgentState(this.workspace, this.presence, clientId),
            }),
        );
    }

    /** Broadcasts a control_changed event for a single session to all clients. */
    private broadcastControl(sessionId: string) {
        this.broadcast({
            type: "control_changed",
            sessionId,
            controlOwnerClientId: this.presence.ownerOf(sessionId),
        });
    }

    /**
     * Pushes a single event to all connected clients.
     *
     * Serialization happens once per broadcast. Individual send failures
     * are isolated so one stale stream cannot prevent other connected browsers
     * from receiving the event.
     */
    private broadcast(event: ServerEvent) {
        const data = JSON.stringify(event);
        for (const send of this.senders.values()) this.pushSafely(send, data);
    }

    /**
     * Pushes one pre-serialized event payload to a client.
     *
     * Send can throw before the route observes stream close. Logging keeps
     * delivery best-effort without propagating transport errors into publishers.
     */
    private pushSafely(send: SseSend, data: string) {
        try {
            send(data);
        } catch (error) {
            console.error("[agentaz-server] sse push failed", error);
        }
    }

    /**
     * Starts the 15-second state snapshot heartbeat (idempotent).
     * Keeps the frontend in sync even if it misses intermediate events
     * due to backpressure or reconnection.
     */
    private ensureHeartbeat() {
        if (this.heartbeat) return;
        this.heartbeat = setInterval(
            () => this.broadcastStateSnapshots(),
            15_000,
        );
    }

    /** Stops the heartbeat timer when no clients remain connected. */
    private stopHeartbeat() {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = undefined;
    }
}
