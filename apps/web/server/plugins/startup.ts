import { configureAgentRuntime } from "../utils/agent-runtime";
/**
 * Nitro startup plugin — the first code that runs when the server process starts.
 *
 * Responsibilities:
 *   1. Configure the process-wide agent runtime with cwd, approval timeout,
 *      and max loaded sessions from runtime config (nuxt.config / env vars).
 *   2. Warn if the server is bound to a non-localhost address without
 *      authentication (local-first security constraint).
 *
 * This plugin runs synchronously during Nitro initialization, before any
 * HTTP routes or WebSocket handlers are registered. It must be the single
 * source of truth for AgentRuntime configuration — calling configureAgentRuntime
 * more than once with different options will throw.
 */
export default defineNitroPlugin(() => {
  const config = useRuntimeConfig();
  const host = process.env.NITRO_HOST || process.env.HOST;

  // Seed the runtime singleton with startup configuration.
  // Values come from runtimeConfig.piWeb (set in nuxt.config.ts or via
  // NUXT_PI_WEB_CWD / NUXT_PI_WEB_APPROVAL_TIMEOUT_MS env vars).
  configureAgentRuntime({
    cwd: String(config.piWeb.cwd),
    approvalTimeoutMs: Number(config.piWeb.approvalTimeoutMs),
    maxLoadedSessions: Number(config.piWeb.maxLoadedSessions),
  });

  // Security: warn if binding to a non-loopback address. The app is
  // designed for local-first single-user use without authentication.
  if (host && !["127.0.0.1", "localhost"].includes(host)) {
    console.warn(
      "WARNING: server is listening on a non-localhost host without authentication:",
      host,
    );
  }
});
