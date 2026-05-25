import type { ServerEvent } from "../../types/protocol";
import {
  getPiSessionRegistry,
  setPiSessionRegistryConfig,
} from "./pi-session-registry";

/** Startup options shared by WebSocket handlers and the process-wide session registry. */
type HubOptions = {
  cwd: string;
  approvalTimeoutMs: number;
  maxLoadedSessions?: number;
};

/**
 * Browser WebSocket connection manager for the server-resident Pi session registry.
 *
 * The hub owns client attachment and heartbeat snapshots. It deliberately does
 * not own Pi session lifetime: closing a browser connection detaches that client and releases its
 * per-session control leases, while loaded sessions continue running in the registry.
 */
export class WsAgentHub {
  private peers = new Set<WsPeer>();
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly options: HubOptions) {}

  /** Opens a browser connection and attaches it to the process-wide session registry. */
  async open(peer: WsPeer, _force = false) {
    this.peers.add(peer);
    await getPiSessionRegistry().attachClient(peer);
    this.startHeartbeat();
  }

  /** Rejects legacy application commands because browser-initiated actions now use HTTP. */
  async message(peer: WsPeer, raw: unknown) {
    if (!this.peers.has(peer)) return;
    console.warn(
      "[pi-web] ignored legacy websocket command",
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
    if (!this.peers.has(peer)) return;
    this.peers.delete(peer);
    getPiSessionRegistry().detachClient(peer);
    if (this.peers.size === 0) this.stopHeartbeat();
  }

  /** Logs a WebSocket error and detaches the failed browser client. */
  async error(peer: WsPeer, error: unknown) {
    console.error("[pi-web] websocket error", error);
    await this.close(peer);
  }

  private send(peer: WsPeer, event: ServerEvent) {
    peer.send(JSON.stringify(event));
  }

  private startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      getPiSessionRegistry().pushSnapshots();
    }, 15_000);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

let hub: WsAgentHub | undefined;
let hubOptions: HubOptions | undefined;

/**
 * Sets the process-wide WebSocket hub and session registry configuration.
 *
 * The first call fixes runtime configuration for the current process. Repeating the call with the same
 * values is allowed so route handlers can be idempotent, but changing values after initialization fails
 * loudly instead of reusing a registry with stale cwd or approval timeout settings.
 */
export function setWsAgentHubConfig(options: HubOptions) {
  if (!hubOptions) {
    hubOptions = options;
    setPiSessionRegistryConfig({
      cwd: options.cwd,
      approvalTimeoutMs: options.approvalTimeoutMs,
      maxLoadedSessions: options.maxLoadedSessions,
    });
    return;
  }

  if (
    hubOptions.cwd !== options.cwd ||
    hubOptions.approvalTimeoutMs !== options.approvalTimeoutMs ||
    hubOptions.maxLoadedSessions !== options.maxLoadedSessions
  ) {
    throw new Error(
      "WsAgentHub configuration cannot be changed after it has been set.",
    );
  }
}

/** Returns the process-wide WebSocket hub used by Nitro route handlers. */
export function getWsAgentHub() {
  if (!hubOptions) {
    throw new Error("WsAgentHub configuration has not been set.");
  }

  hub ??= new WsAgentHub(hubOptions);
  return hub;
}
