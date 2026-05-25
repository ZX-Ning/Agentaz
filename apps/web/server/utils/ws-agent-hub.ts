import type { ServerEvent } from "../../types/protocol";
import type { AgentEventBus, AgentRuntimeEvent } from "./agent-event-bus";
import type { ClientPresence } from "./client-presence";
import type { SessionProjector } from "./session-projector";

/** Minimal WebSocket peer surface needed by the realtime hub. */
export type WsPeer = {
  id?: string;
  send: (data: string) => void;
};

/**
 * Browser WebSocket connection manager for realtime agent events.
 *
 * The hub owns peer lifecycle and event forwarding only. Session lifecycle lives in
 * PiSessionWorkspace, and client focus/control state lives in ClientPresence.
 */
export class WsAgentHub {
  private peers = new Map<string, WsPeer>();
  private heartbeat?: NodeJS.Timeout;
  private unsubscribe?: () => void;

  constructor(
    private readonly eventBus: AgentEventBus,
    private readonly presence: ClientPresence,
    private readonly projector: SessionProjector,
  ) {}

  /** Opens a browser connection, attaches presence, and sends the initial state snapshot. */
  async open(peer: WsPeer, _force = false) {
    const clientId = this.getClientId(peer);
    this.peers.set(clientId, peer);
    this.presence.attachClient(clientId);
    await this.projector.refresh();
    this.send(peer, this.projector.hello(clientId));
    this.sendStateSnapshot(clientId);
    this.startEventSubscription();
    this.startHeartbeat();
  }

  /** Rejects legacy application commands because browser-initiated actions now use HTTP. */
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

  /** Detaches a browser client without aborting or disposing loaded Pi sessions. */
  async close(peer: WsPeer) {
    const clientId = this.getClientId(peer);
    if (!this.peers.has(clientId)) return;
    this.peers.delete(clientId);
    const changedSessionIds = this.presence.detachClient(clientId);
    for (const sessionId of changedSessionIds) this.broadcastControl(sessionId);
    this.broadcastStateSnapshots();
    if (this.peers.size === 0) this.stopHeartbeat();
  }

  /** Logs a WebSocket error and detaches the failed browser client. */
  async error(peer: WsPeer, error: unknown) {
    console.error("[agentaz-server] websocket error", error);
    await this.close(peer);
  }

  private startEventSubscription() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.eventBus.subscribe((event) =>
      this.handleRuntimeEvent(event),
    );
  }

  private handleRuntimeEvent(event: AgentRuntimeEvent) {
    if (event.type === "server_event") {
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
      return;
    }
    this.broadcastStateSnapshots();
  }

  private broadcastStateSnapshots() {
    for (const clientId of this.peers.keys()) this.sendStateSnapshot(clientId);
  }

  private sendStateSnapshot(clientId: string) {
    const peer = this.peers.get(clientId);
    if (!peer) return;
    this.send(peer, {
      type: "state_snapshot",
      state: this.projector.getState(clientId),
    });
  }

  private broadcastControl(sessionId: string) {
    this.broadcast({
      type: "control_changed",
      sessionId,
      controlOwnerClientId: this.presence.ownerOf(sessionId),
    });
  }

  private broadcast(event: ServerEvent) {
    for (const peer of this.peers.values()) this.send(peer, event);
  }

  private send(peer: WsPeer, event: ServerEvent) {
    peer.send(JSON.stringify(event));
  }

  private startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.broadcastStateSnapshots(), 15_000);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private getClientId(peer: WsPeer) {
    if (!peer.id) peer.id = crypto.randomUUID();
    return peer.id;
  }
}
