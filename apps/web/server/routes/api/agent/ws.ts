import { getAgentRuntime } from "../../../utils/agent-runtime";

/**
 * WebSocket endpoint at ws://.../api/agent/ws
 *
 * This is the sole realtime transport for the agent backend. Browser clients
 * connect here to receive server-pushed events: state snapshots, message
 * streaming deltas, tool call updates, extension UI prompts, and status
 * changes. Browser-initiated actions use HTTP APIs — the WebSocket is
 * server-to-client events only.
 *
 * Query params:
 *   - force=1: Allow a second connection to displace the previous one.
 *     By default only one WebSocket per browser tab is supported.
 *
 * Lifecycle events forwarded to the WsAgentHub:
 *   - open:  Client connects → attach presence, send hello + initial state snapshot
 *   - message: Deprecated — browser commands must use HTTP; returns an error event
 *   - close: Client disconnects → detach presence, release control leases
 *   - error: Transport error → detach the failed client
 */
export default defineWebSocketHandler({
  async open(peer) {
    // Parse query parameters from the upgrade request URL.
    const url = new URL(
      peer.request?.url ?? "ws://127.0.0.1/api/agent/ws",
      "ws://127.0.0.1",
    );
    const force = url.searchParams.get("force") === "1";
    await getAgentRuntime().hub.open(peer as any, force);
  },

  async message(peer, message) {
    // Extract text from the WebSocket message frame (string or Buffer).
    const data =
      typeof message === "string"
        ? message
        : (message.text?.() ?? String(message));
    await getAgentRuntime().hub.message(peer as any, data);
  },

  async close(peer) {
    await getAgentRuntime().hub.close(peer as any);
  },

  async error(peer, error) {
    await getAgentRuntime().hub.error(peer as any, error);
  },
});
