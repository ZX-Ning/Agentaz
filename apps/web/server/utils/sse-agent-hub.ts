import type { ServerEvent } from "../../types/protocol";
import type { AgentEventBus, AgentRuntimeEvent } from "./agent-event-bus";
import type { ClientPresence } from "./client-presence";
import type { SessionProjector } from "./session-projector";

/**
 * Abstract SSE output sink for one connected browser client.
 *
 * The route handler creates an h3 EventStream per request and adapts it to
 * this interface before handing it to the hub. Keeping the hub
 * transport-agnostic means the hub never imports h3 directly.
 */
export type SseWriter = {
  /** Pushes one SSE-formatted data line onto the client's event stream. */
  push: (data: string) => void;
  /**
   * Registers a callback that fires when the client disconnects (HTTP
   * connection closed, request aborted, or stream cancelled).
   */
  onClose: (cb: () => void) => void;
};

/**
 * Browser SSE connection manager for realtime agent events.
 *
 * Replaces WsAgentHub. The hub owns SSE writer lifecycle and event
 * forwarding. Session lifecycle lives in PiSessionWorkspace, and client
 * focus/control state lives in ClientPresence. The hub bridges the two
 * via the AgentEventBus.
 *
 * Design principles:
 *   - The hub never loads or disposes Pi sessions — it only reflects their state.
 *   - SSE disconnect does not abort agent work (sessions survive detach).
 *   - State snapshots are broadcast via heartbeat every 15s so the frontend
 *     stays in sync even if it misses intermediate events.
 */
export class SseAgentHub {
  /** Active SSE writers indexed by clientId. */
  private writers = new Map<string, SseWriter>();
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
   * Registers a new SSE client and sends the initial handshake + snapshot.
   *
   * Lifecycle on connect:
   *   1. Register the writer in the writers map.
   *   2. Attach to ClientPresence so the new client gets a default active session.
   *   3. Refresh persisted session data.
   *   4. Push the hello payload (protocol version + full state snapshot).
   *   5. Push a targeted state snapshot to this client.
   *   6. Register disconnect callback on the writer.
   *   7. Start the event bus subscription (lazy, only on first writer).
   *   8. Start the 15s heartbeat.
   *
   * @param clientId - Stable client identifier (crypto.randomUUID).
   * @param writer  - SSE output sink backed by an h3 EventStream.
   */
  async open(clientId: string, writer: SseWriter) {
    // Phase 1: store the writer so broadcast/send can reach it.
    this.writers.set(clientId, writer);

    // Phase 2: register this client in presence tracking so it gets a sensible
    // default active session (last active session from any client, or
    // the first loaded session as fallback).
    this.presence.attachClient(clientId);

    // Phase 3: refresh persisted session cache so the snapshot is current.
    await this.projector.refresh();

    // Phase 4: send the initial hello + targeted state snapshot.
    this.write(writer, this.projector.hello(clientId));
    this.writeStateSnapshot(clientId, writer);

    // Phase 5: detect client disconnect and clean up.
    writer.onClose(() => this.handleDisconnect(clientId));

    // Phase 6: lazy subscription — only subscribe to the event bus when at
    // least one browser client is connected.
    this.startEventSubscription();

    // Phase 7: start periodic state snapshots to keep the frontend in sync.
    this.startHeartbeat();
  }

  /**
   * Detaches a browser client without aborting or disposing loaded Pi sessions.
   *
   * On disconnect:
   *   1. Remove the writer from the active writers map.
   *   2. Detach from ClientPresence — this releases any control leases the
   *      client held and returns the list of affected session ids.
   *   3. Broadcast control_changed for each affected session (so other
   *      connected clients see the updated control ownership).
   *   4. Broadcast state snapshots to all remaining clients.
   *   5. Stop the heartbeat if no clients remain connected.
   */
  private handleDisconnect(clientId: string) {
    if (!this.writers.has(clientId)) return;

    this.writers.delete(clientId);

    // Detach from presence: releases control leases and returns
    // session ids whose control state changed.
    const changedSessionIds = this.presence.detachClient(clientId);
    for (const sessionId of changedSessionIds) this.broadcastControl(sessionId);

    // Refresh all remaining clients with updated state.
    this.broadcastStateSnapshots();

    // Stop the heartbeat timer when no clients are connected.
    if (this.writers.size === 0) this.stopHeartbeat();
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
   *   - server_event: Direct broadcast of the contained ServerEvent to all writers.
   *   - control_changed: Broadcast a control_changed event + full state snapshots
   *     so the frontend can update both the control indicator and session state.
   *   - session_removed: Handled by ClientPresence via the runtime subscription
   *     (not forwarded to writers — the presence update triggers state snapshots).
   *   - state_changed: Broadcast full state snapshots to all writers.
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
    for (const [clientId, writer] of this.writers) {
      this.writeStateSnapshot(clientId, writer);
    }
  }

  /** Sends a state_snapshot event targeted to one specific client. */
  private writeStateSnapshot(clientId: string, writer: SseWriter) {
    this.write(writer, {
      type: "state_snapshot",
      state: this.projector.getState(clientId),
    });
  }

  /** Broadcasts a control_changed event for a single session to all writers. */
  private broadcastControl(sessionId: string) {
    this.broadcast({
      type: "control_changed",
      sessionId,
      controlOwnerClientId: this.presence.ownerOf(sessionId),
    });
  }

  /**
   * Pushes a single event to all connected writers.
   *
   * Serialization happens once per broadcast. Individual writer failures
   * are isolated so one stale stream cannot prevent other connected browsers
   * from receiving the event.
   */
  private broadcast(event: ServerEvent) {
    const data = JSON.stringify(event);
    for (const writer of this.writers.values()) this.pushSafely(writer, data);
  }

  /** Pushes a single event to one writer. */
  private write(writer: SseWriter, event: ServerEvent) {
    this.pushSafely(writer, JSON.stringify(event));
  }

  /**
   * Pushes one pre-serialized event payload to a writer.
   *
   * Writer push can throw when the underlying stream has disconnected but
   * the onClose callback hasn't fired yet. Logging and continuing keeps hub
   * delivery best-effort without propagating transport errors into publishers.
   */
  private pushSafely(writer: SseWriter, data: string) {
    try {
      writer.push(data);
    } catch (error) {
      console.error("[agentaz-server] sse push failed", error);
    }
  }

  /**
   * Starts the 15-second state snapshot heartbeat (idempotent).
   * Keeps the frontend in sync even if it misses intermediate events
   * due to backpressure or reconnection.
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
}
