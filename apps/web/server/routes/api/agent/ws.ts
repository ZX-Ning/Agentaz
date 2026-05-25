import {
  getWsAgentHub,
  setWsAgentHubConfig,
} from "../../../utils/ws-agent-hub";

export default defineWebSocketHandler({
  async open(peer) {
    const url = new URL(
      peer.request?.url ?? "ws://127.0.0.1/api/agent/ws",
      "ws://127.0.0.1",
    );
    const force = url.searchParams.get("force") === "1";
    const config = useRuntimeConfig();
    setWsAgentHubConfig({
      cwd: String(config.piWeb.cwd),
      approvalTimeoutMs: Number(config.piWeb.approvalTimeoutMs),
      maxLoadedSessions: Number(config.piWeb.maxLoadedSessions),
    });
    await getWsAgentHub().open(peer as any, force);
  },

  async message(peer, message) {
    const data =
      typeof message === "string"
        ? message
        : (message.text?.() ?? String(message));
    await getWsAgentHub().message(peer as any, data);
  },

  async close(peer) {
    await getWsAgentHub().close(peer as any);
  },

  async error(peer, error) {
    await getWsAgentHub().error(peer as any, error);
  },
});
