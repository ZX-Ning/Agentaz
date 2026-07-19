import assert from "node:assert/strict";
import { Hono } from "@hono/hono";
import type { ServerEvent, UiRuntimeLoadedSession } from "@agentaz/protocol";
import {
    assertAuthConfig,
    authMiddleware,
    hashAdminPassword,
} from "../../src/auth/auth.ts";
import { agentHttpErrorResponse } from "../../src/http/agent.ts";
import type { PiSessionWorkspace } from "../../src/pi/session-workspace.ts";
import { createAgentRoutes } from "../../src/routes/agent.ts";
import { authRoutes } from "../../src/routes/auth.ts";
import type { AgentRuntime } from "../../src/runtime/agent-runtime.ts";
import { AgentEventBus } from "../../src/runtime/event-bus.ts";
import { ClientPresence } from "../../src/runtime/client-presence.ts";
import { SseAgentHub } from "../../src/runtime/sse-hub.ts";

const ADMIN_PASSWORD = "sse-test-password";
const SESSION_SECRET = "sse-test-secret-012345678901234567";

/**
 * Purpose: Exercise the authenticated SSE lifecycle through a real Hono HTTP stream.
 * Expect: hello/snapshot arrive in order and cancelling the response releases
 * presence, sender, and heartbeat state without disposing loaded sessions.
 * Method: Start an in-process server with a controlled runtime, log in, parse two
 * SSE frames, cancel the reader, and wait for route abort cleanup.
 */
Deno.test({
    name:
        "authenticated SSE stream sends recovery state and cleans up disconnect",
    permissions: {
        env: true,
        net: ["127.0.0.1"],
        read: true,
        sys: ["homedir"],
    },
    async fn() {
        using _authEnv = withAuthEnv();
        assertAuthConfig();

        const eventBus = new AgentEventBus();
        const presence = new ClientPresence();
        const workspace = fakeWorkspace();
        const hub = new SseAgentHub(eventBus, workspace.value, presence);
        const runtime = {
            eventBus,
            presence,
            workspace: workspace.value,
            hub,
        } satisfies AgentRuntime;
        const app = new Hono();
        app.onError(agentHttpErrorResponse);
        app.use("/api/*", authMiddleware);
        app.route("/api", authRoutes);
        app.route("/api", createAgentRoutes(() => runtime));

        const server = Deno.serve(
            {
                hostname: "127.0.0.1",
                port: 0,
                onListen: () => {},
            },
            app.fetch,
        );
        const baseUrl = `http://${server.addr.hostname}:${server.addr.port}`;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
            const login = await fetch(`${baseUrl}/api/auth/login`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ password: ADMIN_PASSWORD }),
            });
            assert.equal(login.status, 200);
            const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
            assert.ok(cookie);

            const response = await fetch(`${baseUrl}/api/agent/events`, {
                headers: { cookie },
            });
            assert.equal(response.status, 200);
            assert.match(
                response.headers.get("content-type") ?? "",
                /^text\/event-stream/,
            );
            assert.ok(response.body);
            reader = response.body.getReader();

            const events = await readSseEvents(reader, 2);
            assert.deepEqual(events.map((event) => event.type), [
                "hello",
                "state_snapshot",
            ]);
            const hello = events[0];
            assert.equal(hello?.type, "hello");
            if (hello?.type === "hello") {
                assert.equal(hello.state.activeSessionId, "session-a");
                assert.equal(
                    hello.state.loadedSessions[0]?.sessionId,
                    "session-a",
                );
                assert.deepEqual(presence.clients(), [hello.clientId]);
            }

            await reader.cancel("test disconnect");
            reader = undefined;
            await waitFor(() => presence.clients().length === 0);

            const hubState = hub as unknown as {
                senders: Map<string, unknown>;
                heartbeat?: unknown;
            };
            assert.equal(hubState.senders.size, 0);
            assert.equal(hubState.heartbeat, undefined);
            assert.equal(workspace.disposeCalls(), 0);
            assert.equal(workspace.refreshCalls(), 1);
        }
        finally {
            await reader?.cancel("test cleanup");
            await server.shutdown();
        }
    },
});

async function readSseEvents(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    count: number,
) {
    const decoder = new TextDecoder();
    const events: ServerEvent[] = [];
    let buffered = "";

    while (events.length < count) {
        const result = await withTimeout(reader.read(), 3_000);
        if (result.done) {
            throw new Error("SSE stream ended before recovery events arrived.");
        }
        buffered += decoder.decode(result.value, { stream: true });
        const frames = buffered.split("\n\n");
        buffered = frames.pop() ?? "";
        for (const frame of frames) {
            const data = frame.split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
            if (data) {
                events.push(JSON.parse(data));
            }
        }
    }
    return events;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timeout = setTimeout(
            () => reject(new Error("Timed out waiting for SSE data.")),
            timeoutMs,
        );
    });
    return Promise.race([promise, expired]).finally(() =>
        clearTimeout(timeout)
    );
}

async function waitFor(condition: () => boolean) {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
        if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for SSE disconnect cleanup.");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function fakeWorkspace() {
    let refreshCount = 0;
    let disposed = 0;
    const session = loadedSession();
    const value = {
        cwd: "/workspace",
        persistedSessions: [],
        loadedSessions: () => [session],
        firstLoadedSessionId: () => session.sessionId,
        refreshPersistedSessionCache: () => {
            refreshCount += 1;
            return Promise.resolve();
        },
        disposeAll: () => {
            disposed += 1;
            return Promise.resolve();
        },
    } as unknown as PiSessionWorkspace;
    return {
        value,
        refreshCalls: () => refreshCount,
        disposeCalls: () => disposed,
    };
}

function loadedSession(): UiRuntimeLoadedSession {
    return {
        file: "/workspace/session-a.jsonl",
        sessionId: "session-a",
        sessionFile: "/workspace/session-a.jsonl",
        name: "Session A",
        createdAt: 1,
        updatedAt: 2,
        isWorking: false,
        isStreaming: false,
        pendingMessageCount: 0,
        pendingApprovalCount: 0,
        pendingUiRequests: [],
        extensionWidgets: [],
    };
}

function withAuthEnv() {
    const previousHash = Deno.env.get("AGENTAZ_ADMIN_PASSWORD_HASH");
    const previousSecret = Deno.env.get("AGENTAZ_SESSION_SECRET");
    Deno.env.set(
        "AGENTAZ_ADMIN_PASSWORD_HASH",
        hashAdminPassword(ADMIN_PASSWORD),
    );
    Deno.env.set("AGENTAZ_SESSION_SECRET", SESSION_SECRET);

    return {
        [Symbol.dispose]() {
            restoreEnv("AGENTAZ_ADMIN_PASSWORD_HASH", previousHash);
            restoreEnv("AGENTAZ_SESSION_SECRET", previousSecret);
        },
    };
}

function restoreEnv(name: string, value: string | undefined) {
    if (value === undefined) {
        Deno.env.delete(name);
    }
    else {
        Deno.env.set(name, value);
    }
}
