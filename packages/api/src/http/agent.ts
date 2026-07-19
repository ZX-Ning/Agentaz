import type { Context } from "@hono/hono";
import type { UiRequestResponseRequest } from "@agentaz/protocol";
import {
    type AgentRuntime,
    getAgentRuntime,
} from "../runtime/agent-runtime.ts";
import { LOCAL_CLIENT_ID } from "../runtime/client-presence.ts";
import {
    AgentazDomainError,
    BadRequestError,
    SessionNotFoundError,
} from "../errors.ts";
import { HttpError, jsonError } from "./errors.ts";

/** Header name for the browser-tab client identity carried on every HTTP request. */
const CLIENT_ID_HEADER = "x-agentaz-client-id";

/** Returns the shared PiSessionWorkspace for use in HTTP route handlers. */
export function getConfiguredAgentRegistry(
    runtime: AgentRuntime = getAgentRuntime(),
) {
    return runtime.workspace;
}

/** Reads the browser tab client id, falling back for non-browser/pre-SSE callers. */
export function requestClientId(c: Context) {
    return c.req.header(CLIENT_ID_HEADER)?.trim() || LOCAL_CLIENT_ID;
}

/** Acquires a short request-scoped session mutation lease. */
export function acquireRequestSessionControl(
    c: Context,
    sessionId: string,
    runtime: AgentRuntime = getAgentRuntime(),
) {
    if (!runtime.workspace.hasSession(sessionId)) {
        throw new SessionNotFoundError();
    }

    const clientId = requestClientId(c);
    runtime.presence.acquireControl(clientId, sessionId);
    runtime.eventBus.publish({
        type: "control_changed",
        sessionId,
        controlOwnerClientId: runtime.presence.ownerOf(sessionId),
    });

    return {
        runtime,
        clientId,
        release() {
            runtime.presence.releaseControl(clientId, sessionId);
            runtime.eventBus.publish({
                type: "control_changed",
                sessionId,
                controlOwnerClientId: runtime.presence.ownerOf(sessionId),
            });
        },
    };
}

/** Runs a short session mutation while holding request-scoped session control. */
export async function withRequestSessionControl<T>(
    c: Context,
    sessionId: string,
    run: (
        lease: ReturnType<typeof acquireRequestSessionControl>,
    ) => T | Promise<T>,
    runtime: AgentRuntime = getAgentRuntime(),
) {
    const lease = acquireRequestSessionControl(c, sessionId, runtime);
    try {
        return await run(lease);
    }
    finally {
        lease.release();
    }
}

/** Reads a required Hono path parameter or throws a structured 400. */
export function requireRouteParam(c: Context, name: string) {
    const value = c.req.param(name);
    if (!value) {
        throw jsonError(
            400,
            "bad_request",
            `Missing route parameter: ${name}`,
        );
    }
    // Hono already decodes route parameters once. Returning its value avoids
    // turning a literal encoded percent into a second path interpretation.
    return value;
}

/** Validates and normalizes a browser-backed extension UI response body. */
export function parseUiRequestResponse(
    body: Partial<UiRequestResponseRequest>,
): UiRequestResponseRequest {
    if (body.kind === "confirm") {
        if (typeof body.confirmed !== "boolean") {
            throw new BadRequestError(
                "Confirm UI responses require confirmed.",
            );
        }
        return { kind: "confirm", confirmed: body.confirmed };
    }

    if (body.kind === "input") {
        if (body.value !== undefined && typeof body.value !== "string") {
            throw new BadRequestError(
                "Input UI response value must be a string.",
            );
        }
        return { kind: "input", value: body.value };
    }

    if (body.kind === "select") {
        if (
            body.selected !== undefined && typeof body.selected !== "string"
        ) {
            throw new BadRequestError(
                "Select UI response selected value must be a string.",
            );
        }
        return { kind: "select", selected: body.selected };
    }

    throw new BadRequestError("UI response kind is required.");
}

/** Maps runtime/domain failures into the existing JSON API error shape. */
export function agentHttpError(error: unknown) {
    if (error instanceof AgentazDomainError) {
        return new HttpError(error.statusCode, error.message, error.data);
    }
    if (error instanceof HttpError) {
        return error;
    }

    // Unknown SDK/runtime failures are server errors. Only typed errors above
    // may opt into a client status; internal details stay in server logs.
    return jsonError(500, "agent_error", "Unexpected server error.");
}

/** Logs unexpected request failures once, then returns the JSON API response. */
export function agentHttpErrorResponse(error: unknown, c: Context) {
    if (
        !(error instanceof HttpError) &&
        !(error instanceof AgentazDomainError)
    ) {
        console.error(
            "[agentaz-server] unexpected request error",
            { method: c.req.method, path: new URL(c.req.url).pathname },
            error,
        );
    }
    const httpError = agentHttpError(error);
    return c.json(httpError.data, {
        status: httpError.status as 400,
    });
}
