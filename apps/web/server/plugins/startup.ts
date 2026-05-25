import { configureAgentRuntime } from "../utils/agent-runtime";

export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig();
  const host = process.env.NITRO_HOST || process.env.HOST;

  configureAgentRuntime({
    cwd: String(config.piWeb.cwd),
    approvalTimeoutMs: Number(config.piWeb.approvalTimeoutMs),
    maxLoadedSessions: Number(config.piWeb.maxLoadedSessions),
  });

  if (host && !["127.0.0.1", "localhost"].includes(host)) {
    console.warn(
      "WARNING: server is listening on a non-localhost host without authentication:",
      host,
    );
  }
});
