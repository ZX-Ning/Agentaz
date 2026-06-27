import {
    configureAgentRuntime,
    initAgentRuntime,
    disposeAgentRuntime,
} from "../utils/agent-runtime";
import { assertAuthConfig } from "../utils/auth";
/**
 * Nitro startup plugin — the first code that runs when the server process starts.
 *
 * Responsibilities:
 *   1. Configure the process-wide agent runtime with cwd, approval timeout,
 *      and max loaded sessions from runtime config (nuxt.config / env vars).
 *   2. Complete auth config, including a process-local session secret when
 *      NUXT_SESSION_PASSWORD is omitted.
 *   3. Warn if the server is bound to a non-localhost address without
 *      authentication (local-first security constraint).
 *
 * This plugin runs synchronously during Nitro initialization, before any
 * HTTP routes or WebSocket handlers are registered. It must be the single
 * source of truth for AgentRuntime configuration — calling configureAgentRuntime
 * more than once with different options will throw.
 */
export default defineNitroPlugin(nitroApp => {
    const config = useRuntimeConfig();
    const host = process.env.NITRO_HOST || process.env.HOST;

    // Fail closed unless the admin password hash is configured. The cookie
    // encryption secret may be generated for this process when omitted.
    assertAuthConfig(config);

    // Resolve runtime configuration from environment variables, falling back
    // to build-time defaults in nuxt.config.ts runtimeConfig.piWeb.
    //
    // IMPORTANT: Nuxt bakes runtimeConfig values at build time. Direct
    // process.env reads in nuxt.config.ts only produce the build-machine
    // value, not the runtime value. Environment variables intended to
    // vary per deployment MUST be read here (or in other server-only code).
    //
    // Fallback chain: env var → runtimeConfig default → runtime process.cwd()
    const cwd =
        process.env.PI_WEB_CWD || String(config.piWeb.cwd) || process.cwd();
    const approvalTimeoutMs =
        Number(process.env.PI_WEB_APPROVAL_TIMEOUT_MS) ||
        Number(config.piWeb.approvalTimeoutMs);
    const maxLoadedSessions =
        Number(process.env.PI_WEB_MAX_LOADED_SESSIONS) ||
        Number(config.piWeb.maxLoadedSessions);

    configureAgentRuntime({
        cwd,
        approvalTimeoutMs,
        maxLoadedSessions,
    });

    // Initialize the process-wide runtime singleton after configuration.
    // This creates the Pi SDK workspace, event bus, presence tracking,
    // session projector, and WebSocket hub.
    initAgentRuntime();
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
