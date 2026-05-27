import type { ServerEvent } from "../../types/protocol";
import type { AgentEventBus, AgentRuntimeEvent } from "./agent-event-bus";
import type { ClientPresence } from "./client-presence";
import type { SessionProjector } from "./session-projector";

/**
 * Minimal WebSocket peer surface needed by the realtime hub.
 * Abstracts over the Nitro/crossws WebSocket peer shape so the hub
 * doesn't need to import WebSocket-specific types.
 */
export type WsPeer = {
  /** Unique identifier assigned on connection. */
  id?: string;
  /** Sends a JSON-stringified message to the connected peer. */
  send: (data: string) => void;
};

/**
 * Browser WebSocket connection manager for realtime agent events.
 *
 * The hub owns peer lifecycle and event forwarding only. Session lifecycle
 * lives in PiSessionWorkspace, and client focus/control state lives in
 * ClientPresence. The hub bridges the two via the AgentEventBus.
 *
 * Design principles:
 *   - The hub never loads or disposes Pi sessions — it only reflects their state.
 *   - WebSocket disconnect does not abort agent work (sessions survive detach).
 *   - State snapshots are broadcast via heartbeat every 15s so the frontend
 *     stays in sync even if it misses intermediate events.
 */
export class WsAgentHub {
  /** Active WebSocket peers indexed by clientId. */
  private peers = new Map<string, WsPeer>();
  /** Periodic state snapshot heartbeat interval (15s). */
  private heartbeat?: NodeJS.Timeout;
  /** Cleanup function for the AgentEventBus subscription. */
  private unsubscribe?: () => void;

  constructor(
    private readonly eventBus: AgentEventBus,
    private readonly presence: ClientPresence,
    private readonly projector: SessionProjector,
  ) {}

  /**
   * Opens a browser WebSocket connection.
   *
   * Lifecycle on connect:
   *   1. Assign (or reuse) a client id for the peer.
   *   2. Register the peer in the peers map.
   *   3. Attach to ClientPresence so the new client gets a default active session.
   *   4. Refresh persisted session data.
   *   5. Send the hello payload (protocol version + full state snapshot).
   *   6. Send a targeted state snapshot to this client.
   *   7. Start the event bus subscription (lazy, only on first peer).
   *   8. Start the 15s heartbeat.
   */
  async open(peer: WsPeer, _force = false) {
    const clientId = this.getClientId(peer);
    this.peers.set(clientId, peer);

    // Register this client in presence tracking so it gets a sensible
    // default active session (last active session from any client, or
    // the first loaded session as fallback).
    this.presence.attachClient(clientId);

    // Refresh persisted session cache so the snapshot is current.
    await this.projector.refresh();

    // Send the initial hello + targeted state snapshot.
    this.send(peer, this.projector.hello(clientId));
    this.sendStateSnapshot(clientId);

    // Lazy subscription: only subscribe to the event bus when at least
    // one browser client is connected.
    this.startEventSubscription();

    // Start periodic state snapshots to keep the frontend in sync.
    this.startHeartbeat();
  }

  /**
   * Rejects legacy application commands from the WebSocket.
   *
   * In an earlier version, the WebSocket carried bidirectional commands.
   * Browser-initiated actions now use HTTP APIs exclusively — the WebSocket
   * is server-to-client events only. Any client-sent message receives an
   * error directing them to use the HTTP API.
   */
  async message(peer: WsPeer, raw: unknown) {
    if (!this.peers.has(this.getClientId(peer))) return;
    console.warn(
      "[agentaz-server] ignored legacy websocket command",
      String(raw).slice(0, 200),
    );
    this.send(peer, {
      type: "error",
      code: "ws_commands_disabled",
      message: "Browser commands must use the HTTP agent API.",
      recoverable: true,
    });
  }

  /**
   * Detaches a browser client without aborting or disposing loaded Pi sessions.
   *
   * On disconnect:
   *   1. Remove the peer from the active peers map.
   *   2. Detach from ClientPresence — this releases any control leases the
   *      client held and returns the list of affected session ids.
   *   3. Broadcast control_changed for each affected session (so other
   *      connected clients see the updated control ownership).
   *   4. Broadcast state snapshots to all remaining clients.
   *   5. Stop the heartbeat if no clients remain connected.
   */
  async close(peer: WsPeer) {
    const clientId = this.getClientId(peer);
    if (!this.peers.has(clientId)) return;

    this.peers.delete(clientId);

    // Detach from presence: releases control leases and returns
    // session ids whose control state changed.
    const changedSessionIds = this.presence.detachClient(clientId);
    for (const sessionId of changedSessionIds) this.broadcastControl(sessionId);

    // Refresh all remaining clients with updated state.
    this.broadcastStateSnapshots();

    // Stop the heartbeat timer when no clients are connected.
    if (this.peers.size === 0) this.stopHeartbeat();
  }

  /** Logs a WebSocket transport error and detaches the failed browser client. */
  async error(peer: WsPeer, error: unknown) {
    console.error("[agentaz-server] websocket error", error);
    await this.close(peer);
  }

  /**
   * Starts the AgentEventBus subscription (idempotent).
   * Only subscribes once regardless of how many clients connect.
   */
  private startEventSubscription() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.eventBus.subscribe((event) =>
      this.handleRuntimeEvent(event),
    );
  }

  /**
   * Routes AgentRuntimeEvents to the appropriate broadcast method.
   *
   * Event routing:
   *   - server_event: Direct broadcast of the contained ServerEvent to all peers.
   *   - control_changed: Broadcast a control_changed event + full state snapshots
   *     so the frontend can update both the control indicator and session state.
   *   - session_removed: Handled by ClientPresence via the runtime subscription
   *     (not forwarded to peers — the presence update triggers state snapshots).
   *   - state_changed: Broadcast full state snapshots to all peers.
   */
  private handleRuntimeEvent(event: AgentRuntimeEvent) {
    if (event.type === "server_event") {
      // Direct forward: session events (streaming deltas, tool calls, etc.)
      // are broadcast as-is to all connected browser clients.
      this.broadcast(event.event);
      return;
    }
    if (event.type === "control_changed") {
      this.broadcast({
        type: "control_changed",
        sessionId: event.sessionId,
        controlOwnerClientId: event.controlOwnerClientId,
      });
      this.broadcastStateSnapshots();
      return;
    }
    if (event.type === "session_removed") {
      // Session removal is handled by the ClientPresence subscription
      // in agent-runtime.ts. We don't forward it because state snapshots
      // will reflect the removed session.
      return;
    }
    // state_changed and any future event types → full state snapshot.
    this.broadcastStateSnapshots();
  }

  /** Sends a state_snapshot event to all connected browser clients. */
  private broadcastStateSnapshots() {
    for (const clientId of this.peers.keys()) this.sendStateSnapshot(clientId);
  }

  /** Sends a state_snapshot event targeted to one specific client. */
  private sendStateSnapshot(clientId: string) {
    const peer = this.peers.get(clientId);
    if (!peer) return;
    this.send(peer, {
      type: "state_snapshot",
      state: this.projector.getState(clientId),
    });
  }

  /** Broadcasts a control_changed event for a single session to all peers. */
  private broadcastControl(sessionId: string) {
    this.broadcast({
      type: "control_changed",
      sessionId,
      controlOwnerClientId: this.presence.ownerOf(sessionId),
    });
  }

  /**
   * Sends a single event to all connected peers.
   *
   * Serialization happens once per broadcast. Individual peer send failures
   * are isolated in sendSerialized() so one stale socket cannot prevent other
   * connected browsers from receiving the event.
   */
  private broadcast(event: ServerEvent) {
    const data = JSON.stringify(event);
    for (const peer of this.peers.values()) this.sendSerialized(peer, data);
  }

  /** Sends a single JSON-serialized event to one peer. */
  private send(peer: WsPeer, event: ServerEvent) {
    this.sendSerialized(peer, JSON.stringify(event));
  }

  /**
   * Sends one pre-serialized event payload to a peer.
   *
   * WebSocket libraries can throw when a peer has disconnected but the close
   * callback has not finished cleanup yet. Logging and continuing keeps hub
   * delivery best-effort without propagating transport errors into publishers.
   */
  private sendSerialized(peer: WsPeer, data: string) {
    try {
      peer.send(data);
    } catch (error) {
      console.error("[agentaz-server] websocket send failed", error);
    }
  }

  /**
   * Starts the 15-second state snapshot heartbeat (idempotent).
   * Keeps the frontend in sync even if it misses intermediate events
   * due to WebSocket backpressure or reconnection.
   */
  private startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.broadcastStateSnapshots(), 15_000);
  }

  /** Stops the heartbeat timer when no clients remain connected. */
  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /**
   * Returns the client id for a peer, assigning a new UUID if one isn't set.
   * Client ids are stable for the lifetime of the WebSocket connection.
   */
  private getClientId(peer: WsPeer) {
    if (!peer.id) peer.id = crypto.randomUUID();
    return peer.id;
  }
}
