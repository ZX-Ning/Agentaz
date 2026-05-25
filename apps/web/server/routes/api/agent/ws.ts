import { getAgentRuntime } from "../../../utils/agent-runtime";

export default defineWebSocketHandler({
  async open(peer) {
    const url = new URL(
      peer.request?.url ?? "ws://127.0.0.1/api/agent/ws",
      "ws://127.0.0.1",
    );
    const force = url.searchParams.get("force") === "1";
    await getAgentRuntime().hub.open(peer as any, force);
  },

  async message(peer, message) {
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
