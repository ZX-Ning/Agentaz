import { Hono } from "@hono/hono";
import {
    configureAgentRuntime,
    disposeAgentRuntime,
    initAgentRuntime,
} from "./runtime/agent-runtime.ts";
import { agentHttpError } from "./http/agent.ts";
import { assertAuthConfig, authMiddleware } from "./auth/auth.ts";
import { HttpError } from "./http/errors.ts";
import { agentRoutes } from "./routes/agent.ts";
import { authRoutes } from "./routes/auth.ts";
import { healthRoutes } from "./routes/health.ts";

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_LOADED_SESSIONS = 5;

let serverRuntimeInitialized = false;

export function createApp() {
    const app = new Hono();

    app.onError((error, c) => {
        const httpError = error instanceof HttpError
            ? error
            : agentHttpError(error);
        return c.json(httpError.data, {
            status: httpError.status as 400,
        });
    });

    app.use("/api/*", authMiddleware);
    app.route("/api", authRoutes);
    app.route("/api", healthRoutes);
    app.route("/api", agentRoutes);

    return app;
}

function numberEnv(name: string, fallback: number) {
    const raw = Deno.env.get(name);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function initServerRuntime() {
    if (serverRuntimeInitialized) return;

    assertAuthConfig();

    const cwd = Deno.env.get("PI_WEB_CWD") || Deno.cwd();
    const approvalTimeoutMs = numberEnv(
        "PI_WEB_APPROVAL_TIMEOUT_MS",
        DEFAULT_APPROVAL_TIMEOUT_MS,
    );
    const maxLoadedSessions = numberEnv(
        "PI_WEB_MAX_LOADED_SESSIONS",
        DEFAULT_MAX_LOADED_SESSIONS,
    );

    configureAgentRuntime({ cwd, approvalTimeoutMs, maxLoadedSessions });
    initAgentRuntime();
    serverRuntimeInitialized = true;

    addEventListener("unload", () => {
        void disposeAgentRuntime();
    });

    const host = Deno.env.get("HOST") || Deno.env.get("DENO_HOST");
    if (host && !["127.0.0.1", "localhost"].includes(host)) {
        console.warn(
            "WARNING: server is listening on a non-localhost host; ensure single-user auth is intentionally exposed:",
            host,
        );
    }
}

export const app = createApp();

if (import.meta.main) {
    initServerRuntime();
}

export default {
    fetch(request: Request) {
        initServerRuntime();
        return app.fetch(request);
    },
};
