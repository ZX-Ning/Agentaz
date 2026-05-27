import {
  configureAgentRuntime,
  disposeAgentRuntime,
} from "../utils/agent-runtime";
import { assertAuthConfig } from "../utils/auth";
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
export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig();
  const host = process.env.NITRO_HOST || process.env.HOST;

  // Fail closed unless the single-user admin auth secrets are configured.
  assertAuthConfig();

  // Seed the runtime singleton with startup configuration.
  // Values come from runtimeConfig.piWeb (set in nuxt.config.ts or via
  // PI_WEB_CWD / PI_WEB_APPROVAL_TIMEOUT_MS / PI_WEB_MAX_LOADED_SESSIONS).
  configureAgentRuntime({
    cwd: String(config.piWeb.cwd),
    approvalTimeoutMs: Number(config.piWeb.approvalTimeoutMs),
    maxLoadedSessions: Number(config.piWeb.maxLoadedSessions),
  });

  // Security: warn if binding to a non-loopback address. Auth is present, but
  // the app still exposes a powerful single-user coding agent control surface.
  if (host && !["127.0.0.1", "localhost"].includes(host)) {
    console.warn(
      "WARNING: server is listening on a non-localhost host; ensure single-user auth is intentionally exposed:",
      host,
    );
  }

  // Dispose loaded Pi sessions during graceful Nitro shutdown. This hook is
  // best-effort: it only touches the runtime if an agent request initialized it.
  nitroApp.hooks.hook("close", async () => {
    await disposeAgentRuntime();
  });
});
