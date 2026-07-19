import assert from "node:assert/strict";
import { Hono } from "@hono/hono";
import type {
    MessageSubmitRequest,
    ModelStateResponse,
    PermissionSystemConfig,
    ServerEvent,
    UiRuntimeLoadedSession,
} from "@agentaz/protocol";
import type { PiSessionWorkspace } from "../../src/pi/session-workspace.ts";
import { defaultPermissionConfig } from "../../src/extensions/permission-config.ts";
import {
    agentHttpError,
    agentHttpErrorResponse,
} from "../../src/http/agent.ts";
import { createAgentRoutes } from "../../src/routes/agent.ts";
import type { AgentRuntime } from "../../src/runtime/agent-runtime.ts";
import { AgentEventBus } from "../../src/runtime/event-bus.ts";
import { ClientPresence } from "../../src/runtime/client-presence.ts";
import type { SseAgentHub } from "../../src/runtime/sse-hub.ts";

/**
 * Purpose: Verify successful agent HTTP routes operate against the injected runtime
 * and carry browser client identity through session focus and state projection.
 * Expect: State/create/focus and permission config routes return coherent JSON contracts.
 * Method: Mount createAgentRoutes with an in-memory workspace and call representative endpoints.
 */
Deno.test("agent routes expose state, session focus, and permission config", async () => {
    const harness = routeHarness();

    const initial = await requestJson(harness.app, "GET", "/api/agent/state", {
        clientId: "client-a",
    });
    assert.equal(initial.response.status, 200);
    assert.deepEqual(initial.payload.loadedSessions, []);

    const created = await requestJson(
        harness.app,
        "POST",
        "/api/agent/sessions",
        {
            clientId: "client-a",
            body: {},
        },
    );
    assert.equal(created.response.status, 200);
    assert.equal(created.payload.sessionId, "session-1");
    assert.equal(created.payload.activeSessionId, "session-1");

    await requestJson(harness.app, "POST", "/api/agent/sessions", {
        clientId: "client-a",
        body: {},
    });
    const focused = await requestJson(
        harness.app,
        "POST",
        "/api/agent/sessions/session-1/focus",
        { clientId: "client-a" },
    );
    assert.equal(focused.response.status, 200);
    assert.equal(focused.payload.activeSessionId, "session-1");

    const permission = defaultPermissionConfig();
    permission.permission.read = "deny";
    const saved = await requestJson(
        harness.app,
        "PUT",
        "/api/agent/permissions/config",
        { body: { config: permission } },
    );
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.config.permission.read, "deny");

    const loaded = await requestJson(
        harness.app,
        "GET",
        "/api/agent/permissions/config",
    );
    assert.equal(loaded.payload.config.permission.read, "deny");

    const reset = await requestJson(
        harness.app,
        "POST",
        "/api/agent/permissions/config/reset",
    );
    assert.equal(reset.payload.exists, false);
    assert.equal(harness.workspace.permissionConfig.permission.read, "allow");
});

/**
 * Purpose: Verify route validation and missing-session failures remain structured
 * client errors rather than leaking implementation exceptions.
 * Expect: Malformed/invalid bodies return 400 and unknown loaded sessions return 404.
 * Method: Submit malformed JSON, unsupported message/UI payloads, and an unknown abort.
 */
Deno.test("agent routes validate bodies and classify missing sessions", async () => {
    const harness = routeHarness();
    harness.workspace.addSession("session-a");

    const malformed = await harness.app.request(
        "/api/agent/sessions/session-a/messages",
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{invalid",
        },
    );
    assert.equal(malformed.status, 400);
    assert.equal(
        (await malformed.json()).message,
        "Malformed JSON request body.",
    );

    const unsupported = await requestJson(
        harness.app,
        "POST",
        "/api/agent/sessions/session-a/messages",
        { body: { mode: "later", text: "hello" } },
    );
    assert.equal(unsupported.response.status, 400);
    assert.equal(unsupported.payload.code, "bad_request");

    const invalidUi = await requestJson(
        harness.app,
        "POST",
        "/api/agent/sessions/session-a/ui-requests/request-a/response",
        { body: { kind: "confirm", confirmed: "yes" } },
    );
    assert.equal(invalidUi.response.status, 400);

    const missing = await requestJson(
        harness.app,
        "POST",
        "/api/agent/sessions/missing/abort",
        { clientId: "client-a" },
    );
    assert.equal(missing.response.status, 404);
    assert.equal(missing.payload.code, "session_not_found");
    assert.equal(harness.presence.ownerOf("missing"), undefined);
});

/**
 * Purpose: Pin the dormant model-context failure contract at the production HTTP boundary.
 * Expect: One contextual server log accompanies a generic client-safe 500 response.
 * Method: Inject the controller-style contextual error into GET models and capture the boundary.
 */
Deno.test("agent model route logs context once and redacts dormant failures", async () => {
    using errors = captureConsoleErrors();
    const harness = routeHarness(true);
    harness.workspace.addSession("session-corrupt");
    harness.workspace.modelStateFailure = new Error(
        "Failed to build persisted model context for session session-corrupt.",
        { cause: new Error("corrupt session entry") },
    );

    const result = await requestJson(
        harness.app,
        "GET",
        "/api/agent/sessions/session-corrupt/models",
    );

    assert.equal(result.response.status, 500);
    assert.deepEqual(result.payload, {
        code: "agent_error",
        message: "Unexpected server error.",
        recoverable: false,
    });
    assert.equal(errors.messages.length, 1);
    assert.deepEqual(errors.messages[0]?.[1], {
        method: "GET",
        path: "/api/agent/sessions/session-corrupt/models",
    });
    assert.match(String(errors.messages[0]?.[2]), /session-corrupt/);
    assert.doesNotMatch(JSON.stringify(result.payload), /corrupt session/);
});

/**
 * Purpose: Verify short mutation routes hold one client-scoped lease, reject another
 * client concurrently, and release control on both success and failure.
 * Expect: The owner is visible while model mutation waits; every terminal path clears it.
 * Method: Gate one model request, race thinking from another client, then inject a model error.
 */
Deno.test("agent mutation routes balance control leases on success and failure", async () => {
    const harness = routeHarness();
    harness.workspace.addSession("session-a");
    const controlEvents: ServerEvent[] = [];
    harness.eventBus.subscribe((event) => {
        if (event.type === "control_changed") {
            controlEvents.push({
                type: "control_changed",
                sessionId: event.sessionId,
                controlOwnerClientId: event.controlOwnerClientId,
            });
        }
    });

    const gate = Promise.withResolvers<void>();
    harness.workspace.modelGate = gate.promise;
    const modelRequest = requestJson(
        harness.app,
        "PUT",
        "/api/agent/sessions/session-a/model",
        {
            clientId: "client-a",
            body: { provider: "test", id: "model" },
        },
    );
    await harness.workspace.modelStarted.promise;
    assert.equal(harness.presence.ownerOf("session-a"), "client-a");

    const conflict = await requestJson(
        harness.app,
        "PUT",
        "/api/agent/sessions/session-a/thinking",
        { clientId: "client-b", body: { level: "high" } },
    );
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.payload.code, "session_control_conflict");

    gate.resolve();
    assert.equal((await modelRequest).response.status, 200);
    assert.equal(harness.presence.ownerOf("session-a"), undefined);

    harness.workspace.modelGate = undefined;
    harness.workspace.modelFailure = new Error("model failed");
    const failed = await requestJson(
        harness.app,
        "PUT",
        "/api/agent/sessions/session-a/model",
        {
            clientId: "client-a",
            body: { provider: "test", id: "model" },
        },
    );
    assert.equal(failed.response.status, 500);
    assert.equal(harness.presence.ownerOf("session-a"), undefined);
    assert.deepEqual(
        controlEvents.map((event) =>
            event.type === "control_changed"
                ? event.controlOwnerClientId
                : undefined
        ),
        ["client-a", undefined, "client-a", undefined],
    );
});

/**
 * Purpose: Verify fire-and-forget message requests retain control until the agent
 * task settles while synchronous submission failures release immediately.
 * Expect: Another client conflicts before settlement and succeeds after callback release.
 * Method: Submit prompt, invoke captured onSettled, then repeat with a synchronous throw.
 */
Deno.test("agent message route holds control through background settlement", async () => {
    const harness = routeHarness();
    harness.workspace.addSession("session-a");

    const accepted = await requestJson(
        harness.app,
        "POST",
        "/api/agent/sessions/session-a/messages",
        {
            clientId: "client-a",
            body: {
                mode: "prompt",
                clientMessageId: "message-a",
                text: "hello",
            },
        },
    );
    assert.equal(accepted.response.status, 200);
    assert.equal(harness.presence.ownerOf("session-a"), "client-a");

    const conflict = await requestJson(
        harness.app,
        "POST",
        "/api/agent/sessions/session-a/abort",
        { clientId: "client-b" },
    );
    assert.equal(conflict.response.status, 409);

    harness.workspace.settleMessage?.();
    assert.equal(harness.presence.ownerOf("session-a"), undefined);

    harness.workspace.submitFailure = new Error("submit failed");
    const failed = await requestJson(
        harness.app,
        "POST",
        "/api/agent/sessions/session-a/messages",
        {
            clientId: "client-a",
            body: {
                mode: "prompt",
                clientMessageId: "message-b",
                text: "again",
            },
        },
    );
    assert.equal(failed.response.status, 500);
    assert.equal(harness.presence.ownerOf("session-a"), undefined);
});

function routeHarness(useProductionErrorBoundary = false) {
    const eventBus = new AgentEventBus();
    const presence = new ClientPresence();
    const workspace = new FakeAgentWorkspace();
    const runtime = {
        eventBus,
        presence,
        workspace: workspace as unknown as PiSessionWorkspace,
        hub: {
            open: () => Promise.resolve(),
            close: () => {},
        } as unknown as SseAgentHub,
    } satisfies AgentRuntime;
    const app = new Hono();
    app.onError(
        useProductionErrorBoundary ? agentHttpErrorResponse : (error, c) => {
            const mapped = agentHttpError(error);
            return c.json(mapped.data, { status: mapped.status as 400 });
        },
    );
    app.route("/api", createAgentRoutes(() => runtime));
    return { app, eventBus, presence, workspace };
}

class FakeAgentWorkspace {
    cwd = "/workspace";
    persistedSessions: never[] = [];
    permissionConfig = defaultPermissionConfig();
    modelGate?: Promise<void>;
    modelFailure?: Error;
    modelStateFailure?: Error;
    modelStarted = Promise.withResolvers<void>();
    submitFailure?: Error;
    settleMessage?: () => void;
    private sessions = new Map<string, UiRuntimeLoadedSession>();
    private nextSession = 1;

    addSession(sessionId: string) {
        const session = loadedSession(sessionId);
        this.sessions.set(sessionId, session);
        return session;
    }

    loadedSessions() {
        return [...this.sessions.values()];
    }

    firstLoadedSessionId() {
        return this.sessions.keys().next().value as string | undefined;
    }

    hasSession(sessionId: string) {
        return this.sessions.has(sessionId);
    }

    refreshPersistedSessionCache() {
        return Promise.resolve();
    }

    createLoadedSession() {
        const sessionId = `session-${this.nextSession++}`;
        this.addSession(sessionId);
        return Promise.resolve({
            sessionId,
            sessionFile: `/workspace/${sessionId}.jsonl`,
        });
    }

    openLoadedSession(sessionFile: string) {
        const sessionId = `session-${this.nextSession++}`;
        this.addSession(sessionId);
        return Promise.resolve({ sessionId, sessionFile });
    }

    getProjectPermissionConfig() {
        return Promise.resolve(this.permissionResponse(true));
    }

    setProjectPermissionConfig(config: PermissionSystemConfig) {
        this.permissionConfig = structuredClone(config);
        return Promise.resolve(this.permissionResponse(true));
    }

    resetProjectPermissionConfig() {
        this.permissionConfig = defaultPermissionConfig();
        return Promise.resolve(this.permissionResponse(false));
    }

    getDefaultModelState() {
        return this.modelState("");
    }

    getSessionEntries(sessionId: string) {
        return { sessionId, entries: [] };
    }

    getSessionHistory(sessionId: string) {
        return { sessionId, revision: 0, messages: [] };
    }

    getSessionModelState(sessionId: string) {
        if (this.modelStateFailure) {
            throw this.modelStateFailure;
        }
        return this.modelState(sessionId);
    }

    async setSessionModel(sessionId: string, _provider: string, _id: string) {
        this.modelStarted.resolve();
        await this.modelGate;
        if (this.modelFailure) {
            throw this.modelFailure;
        }
        return this.modelState(sessionId);
    }

    setSessionThinkingLevel(sessionId: string) {
        return Promise.resolve(this.modelState(sessionId));
    }

    submitMessage(
        sessionId: string,
        request: MessageSubmitRequest,
        onSettled?: () => void,
    ) {
        if (this.submitFailure) {
            throw this.submitFailure;
        }
        this.settleMessage = onSettled;
        return {
            accepted: true,
            sessionId,
            clientMessageId: request.mode === "prompt"
                ? request.clientMessageId
                : undefined,
            turnId: request.mode === "prompt" ? "turn-a" : undefined,
        };
    }

    abortSession() {
        return Promise.resolve();
    }

    clearSessionQueue() {
        return Promise.resolve();
    }

    resolveUiRequest() {}

    private modelState(sessionId: string): ModelStateResponse {
        return {
            sessionId,
            models: [],
            thinkingLevel: "off",
            availableThinkingLevels: ["off", "high"],
        };
    }

    private permissionResponse(exists: boolean) {
        return {
            scope: "project" as const,
            cwd: this.cwd,
            configPath:
                "/workspace/.pi/extensions/pi-permission-system/config.json",
            exists,
            config: structuredClone(this.permissionConfig),
        };
    }
}

function captureConsoleErrors() {
    const original = console.error;
    const messages: unknown[][] = [];
    console.error = (...args: unknown[]) => messages.push(args);
    return {
        messages,
        [Symbol.dispose]() {
            console.error = original;
        },
    };
}

function loadedSession(sessionId: string): UiRuntimeLoadedSession {
    return {
        file: `/workspace/${sessionId}.jsonl`,
        sessionId,
        sessionFile: `/workspace/${sessionId}.jsonl`,
        name: sessionId,
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

async function requestJson(
    app: Hono,
    method: string,
    path: string,
    options: { clientId?: string; body?: unknown } = {},
) {
    const headers = new Headers();
    if (options.clientId) {
        headers.set("x-agentaz-client-id", options.clientId);
    }
    if (options.body !== undefined) {
        headers.set("content-type", "application/json");
    }
    const response = await app.request(path, {
        method,
        headers,
        body: options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
    });
    const text = await response.text();
    return {
        response,
        payload: text ? JSON.parse(text) : undefined,
    };
}
