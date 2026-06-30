import { Hono } from "@hono/hono";
import { streamSSE } from "@hono/hono/streaming";
import type {
    ContextCompactRequest,
    ContextCompactResponse,
    MessageSubmitRequest,
    MessageSubmitResponse,
    ModelSetRequest,
    SessionCreateRequest,
    SessionDeleteRequest,
    SessionEntriesResponse,
    SessionForkRequest,
    SessionOperationResponse,
    SessionRenameRequest,
    SessionRevertRequest,
    ThinkingSetRequest,
    UiRequestResponseRequest,
} from "@agentaz/protocol";
import {
    acquireRequestSessionControl,
    getConfiguredAgentRegistry,
    parseUiRequestResponse,
    readJsonBody,
    requestClientId,
    requireRouteParam,
    withRequestSessionControl,
} from "../http/agent.ts";
import { getAgentRuntime } from "../runtime/agent-runtime.ts";
import { BadRequestError, SessionNotFoundError } from "../errors.ts";
import {
    getAgentState,
    refreshProjectionData,
} from "../runtime/session-projector.ts";

export const agentRoutes = new Hono();

agentRoutes.get("/agent/events", (c) => {
    const clientId = crypto.randomUUID();
    const hub = getAgentRuntime().hub;

    return streamSSE(c, async (stream) => {
        stream.onAbort(() => hub.close(clientId));
        await hub.open(clientId, (data) => {
            void stream.writeSSE({ data });
        });
        await new Promise<void>(() => undefined);
    });
});

agentRoutes.get(
    "/agent/models",
    (c) => c.json(getConfiguredAgentRegistry().getDefaultModelState()),
);

agentRoutes.get("/agent/state", async (c) => {
    const runtime = getAgentRuntime();
    await refreshProjectionData(runtime.workspace);
    return c.json(
        getAgentState(
            runtime.workspace,
            runtime.presence,
            requestClientId(c),
        ),
    );
});

agentRoutes.post("/agent/sessions", async (c) => {
    const body = await readJsonBody<SessionCreateRequest>(c);
    const runtime = getAgentRuntime();
    const clientId = requestClientId(c);
    const controller = body.sessionFile
        ? await runtime.workspace.openLoadedSession(body.sessionFile)
        : await runtime.workspace.createLoadedSession();

    runtime.presence.focus(clientId, controller.sessionId);
    return c.json({
        ...getAgentState(runtime.workspace, runtime.presence, clientId),
        sessionId: controller.sessionId,
        sessionFile: controller.sessionFile,
    });
});

agentRoutes.post("/agent/sessions/delete", async (c) => {
    const body = await readJsonBody<SessionDeleteRequest>(c);
    const runtime = getAgentRuntime();
    const clientId = requestClientId(c);
    const result = await runtime.workspace.softDeletePersistedSession(
        body.sessionFile ?? "",
    );

    return c.json({
        ...getAgentState(runtime.workspace, runtime.presence, clientId),
        ...result,
    });
});

agentRoutes.patch("/agent/sessions/metadata", async (c) => {
    const body = await readJsonBody<SessionRenameRequest>(c);
    const runtime = getAgentRuntime();
    const clientId = requestClientId(c);
    const result = await runtime.workspace.renamePersistedSession(
        body.sessionFile ?? "",
        body.name ?? "",
    );

    return c.json({
        ...getAgentState(runtime.workspace, runtime.presence, clientId),
        ...result,
    });
});

agentRoutes.post("/agent/sessions/:sessionId/focus", (c) => {
    const runtime = getAgentRuntime();
    const sessionId = requireRouteParam(c, "sessionId");
    if (!runtime.workspace.hasSession(sessionId)) {
        throw new SessionNotFoundError();
    }

    const clientId = requestClientId(c);
    runtime.presence.focus(clientId, sessionId);
    runtime.eventBus.publish({ type: "state_changed" });

    return c.json({
        ...getAgentState(runtime.workspace, runtime.presence, clientId),
        sessionId,
    });
});

agentRoutes.get(
    "/agent/sessions/:sessionId/entries",
    (c) =>
        c.json<SessionEntriesResponse>(
            getConfiguredAgentRegistry().getSessionEntries(
                requireRouteParam(c, "sessionId"),
            ),
        ),
);

agentRoutes.get("/agent/sessions/:sessionId/history", (c) =>
    c.json(
        getConfiguredAgentRegistry().getSessionHistory(
            requireRouteParam(c, "sessionId"),
        ),
    ));

agentRoutes.get("/agent/sessions/:sessionId/models", (c) =>
    c.json(
        getConfiguredAgentRegistry().getSessionModelState(
            requireRouteParam(c, "sessionId"),
        ),
    ));

agentRoutes.put("/agent/sessions/:sessionId/model", async (c) => {
    const sessionId = requireRouteParam(c, "sessionId");
    const body = await readJsonBody<ModelSetRequest>(c);
    if (!body.provider || !body.id) {
        throw new BadRequestError("Model provider and id are required.");
    }

    return c.json(
        await withRequestSessionControl(
            c,
            sessionId,
            (lease) =>
                lease.runtime.workspace.setSessionModel(
                    sessionId,
                    body.provider!,
                    body.id!,
                ),
        ),
    );
});

agentRoutes.put("/agent/sessions/:sessionId/thinking", async (c) => {
    const sessionId = requireRouteParam(c, "sessionId");
    const body = await readJsonBody<ThinkingSetRequest>(c);
    if (!body.level) {
        throw new BadRequestError("Thinking level is required.");
    }

    return c.json(
        await withRequestSessionControl(
            c,
            sessionId,
            (lease) =>
                lease.runtime.workspace.setSessionThinkingLevel(
                    sessionId,
                    body.level!,
                ),
        ),
    );
});

agentRoutes.post("/agent/sessions/:sessionId/messages", async (c) => {
    const sessionId = requireRouteParam(c, "sessionId");
    const body = await readJsonBody<MessageSubmitRequest>(c);

    if (!body.text || !body.mode) {
        throw new BadRequestError("Message mode and text are required.");
    }
    if (
        body.mode !== "prompt" &&
        body.mode !== "steer" &&
        body.mode !== "follow_up"
    ) {
        throw new BadRequestError("Unsupported message mode.");
    }

    const clientMessageId = "clientMessageId" in body
        ? body.clientMessageId
        : undefined;
    if (body.mode === "prompt" && !clientMessageId) {
        throw new BadRequestError(
            "clientMessageId is required for prompt messages.",
        );
    }

    const lease = acquireRequestSessionControl(c, sessionId);
    try {
        const onSettled = lease.release;
        const response: MessageSubmitResponse = body.mode === "prompt"
            ? await lease.runtime.workspace.submitMessage(
                sessionId,
                {
                    mode: "prompt",
                    clientMessageId: clientMessageId!,
                    text: body.text,
                    images: body.images,
                },
                onSettled,
            )
            : await lease.runtime.workspace.submitMessage(
                sessionId,
                {
                    mode: body.mode,
                    text: body.text,
                    images: body.images,
                },
                onSettled,
            );
        return c.json(response);
    }
    catch (error) {
        lease.release();
        throw error;
    }
});

agentRoutes.post("/agent/sessions/:sessionId/fork", async (c) => {
    const sessionId = requireRouteParam(c, "sessionId");
    const body = await readJsonBody<SessionForkRequest>(c);
    const clientId = requestClientId(c);
    const controller = await withRequestSessionControl(
        c,
        sessionId,
        (lease) =>
            lease.runtime.workspace.forkSession(sessionId, {
                entryId: body.entryId,
                name: body.name,
            }),
    );

    const runtime = getAgentRuntime();
    runtime.presence.focus(clientId, controller.sessionId);
    runtime.eventBus.publish({ type: "state_changed" });

    return c.json<SessionOperationResponse>({
        ...getAgentState(runtime.workspace, runtime.presence, clientId),
        sessionId: controller.sessionId,
        sessionFile: controller.sessionFile,
    });
});

agentRoutes.post("/agent/sessions/:sessionId/revert", async (c) => {
    const sessionId = requireRouteParam(c, "sessionId");
    const body = await readJsonBody<SessionRevertRequest>(c);
    const clientId = requestClientId(c);
    if (!body.entryId) {
        throw new BadRequestError("Session entry id is required.");
    }

    const controller = await withRequestSessionControl(
        c,
        sessionId,
        (lease) =>
            lease.runtime.workspace.revertSession(sessionId, body.entryId!),
    );

    const runtime = getAgentRuntime();
    runtime.presence.focus(clientId, controller.sessionId);
    runtime.eventBus.publish({ type: "state_changed" });

    return c.json<SessionOperationResponse>({
        ...getAgentState(runtime.workspace, runtime.presence, clientId),
        sessionId: controller.sessionId,
        sessionFile: controller.sessionFile,
    });
});

agentRoutes.post("/agent/sessions/:sessionId/compact", async (c) => {
    const sessionId = requireRouteParam(c, "sessionId");
    const body = await readJsonBody<ContextCompactRequest>(c);
    if (
        body.customInstructions !== undefined &&
        typeof body.customInstructions !== "string"
    ) {
        throw new BadRequestError(
            "customInstructions must be a string when provided.",
        );
    }

    return c.json<ContextCompactResponse>(
        await withRequestSessionControl(
            c,
            sessionId,
            (lease) =>
                lease.runtime.workspace.compactSession(sessionId, {
                    customInstructions: body.customInstructions?.trim() ||
                        undefined,
                }),
        ),
    );
});

agentRoutes.post("/agent/sessions/:sessionId/abort", async (c) => {
    const sessionId = requireRouteParam(c, "sessionId");
    await withRequestSessionControl(
        c,
        sessionId,
        (lease) => lease.runtime.workspace.abortSession(sessionId),
    );
    return c.json({ ok: true, sessionId });
});

agentRoutes.post("/agent/sessions/:sessionId/queue/clear", async (c) => {
    const sessionId = requireRouteParam(c, "sessionId");
    await withRequestSessionControl(
        c,
        sessionId,
        (lease) => lease.runtime.workspace.clearSessionQueue(sessionId),
    );
    return c.json({ ok: true, sessionId });
});

agentRoutes.post(
    "/agent/sessions/:sessionId/ui-requests/:requestId/response",
    async (c) => {
        const sessionId = requireRouteParam(c, "sessionId");
        const requestId = requireRouteParam(c, "requestId");
        const body = parseUiRequestResponse(
            await readJsonBody<UiRequestResponseRequest>(c),
        );

        await withRequestSessionControl(
            c,
            sessionId,
            async (lease) =>
                lease.runtime.workspace.resolveUiRequest(
                    sessionId,
                    requestId,
                    body,
                ),
        );
        return c.json({ ok: true, sessionId, requestId });
    },
);
