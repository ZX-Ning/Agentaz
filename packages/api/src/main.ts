import { Hono } from "@hono/hono";
import { serveStatic } from "@hono/hono/deno";
import { join } from "node:path";
import {
    configureAgentRuntime,
    disposeAgentRuntime,
    initAgentRuntime,
} from "./runtime/agent-runtime.ts";
import { agentHttpErrorResponse } from "./http/agent.ts";
import { apiBodyLimit } from "./http/body-limit.ts";
import { assertAuthConfig, authMiddleware } from "./auth/auth.ts";
import { agentRoutes } from "./routes/agent.ts";
import { authRoutes } from "./routes/auth.ts";
import { healthRoutes } from "./routes/health.ts";

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_LOADED_SESSIONS = 5;

let serverRuntimeInitialized = false;

export interface CreateAppOptions {
    /** Overrides env lookup for isolated app instances and tests. */
    staticDir?: string | null;
    readTextFile?: (path: string) => Promise<string>;
}

export function createApp(options: CreateAppOptions = {}) {
    const app = new Hono();

    app.onError(agentHttpErrorResponse);

    // Reject oversized declared-length and streamed bodies before auth or JSON parsing.
    app.use("/api/*", apiBodyLimit, authMiddleware);
    app.route("/api", authRoutes);
    app.route("/api", healthRoutes);
    app.route("/api", agentRoutes);

    const staticDir = options.staticDir === undefined
        ? Deno.env.get("STATIC_FILE_DIR")
        : options.staticDir ?? undefined;
    if (staticDir) {
        console.log(`Serving static files: ${staticDir}`);
        const readTextFile = options.readTextFile ?? Deno.readTextFile;
        let spaShellPromise: Promise<string> | undefined;

        // Cache only within this app instance. A failed read is retryable so a
        // temporarily missing deployment artifact does not poison the process.
        const readSpaShell = () => {
            if (!spaShellPromise) {
                spaShellPromise = readTextFile(join(staticDir, "index.html"))
                    .catch((error) => {
                        spaShellPromise = undefined;
                        throw error;
                    });
            }
            return spaShellPromise;
        };

        app.use(
            "*",
            serveStatic({ root: staticDir, precompressed: true }),
        );

        // SPA history fallback: unknown browser document routes -> index.html.
        app.get("*", async (c) => {
            if (!isSpaFallbackRequest(c.req.raw)) {
                return c.notFound();
            }

            return c.html(
                await readSpaShell(),
            );
        });
    }
    else {
        console.log(`STATIC_FILE_DIR not set. Not serving static files.`);
    }

    return app;
}

function isSpaFallbackRequest(request: Request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
        return false;
    }

    return request.headers.get("accept")?.includes("text/html") ?? false;
}

function numberEnv(name: string, fallback: number) {
    const raw = Deno.env.get(name);
    if (!raw) {
        return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function initServerRuntime() {
    if (serverRuntimeInitialized) {
        return;
    }

    assertAuthConfig();
    warnForNetworkExposure();

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
}

/** Warns when deployment metadata says the server is reachable beyond loopback. */
export function warnForNetworkExposure() {
    const bindHost = Deno.env.get("AGENTAZ_BIND_HOST")?.trim() || "127.0.0.1";
    if (
        bindHost !== "127.0.0.1" && bindHost !== "localhost" &&
        bindHost !== "::1"
    ) {
        console.warn(
            `[agentaz-server] WARNING: server bind host ${bindHost} may expose the single-user coding agent to the network. Publish ports only on loopback or a trusted network.`,
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
