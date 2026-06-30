import type { Context } from "@hono/hono";
import type { UiRequestResponseRequest } from "@agentaz/protocol";
import { getAgentRuntime } from "../runtime/agent-runtime.ts";
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
export function getConfiguredAgentRegistry() {
    return getAgentRuntime().workspace;
}

/** Reads the browser tab client id, falling back for non-browser/pre-SSE callers. */
export function requestClientId(c: Context) {
    return c.req.header(CLIENT_ID_HEADER)?.trim() || LOCAL_CLIENT_ID;
}

/** Acquires a short request-scoped session mutation lease. */
export function acquireRequestSessionControl(c: Context, sessionId: string) {
    const runtime = getAgentRuntime();

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
    ) => Promise<T>,
) {
    const lease = acquireRequestSessionControl(c, sessionId);
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
    return decodeURIComponent(value);
}

/** Reads a JSON body, defaulting empty bodies to `{}` and rejecting malformed JSON. */
export async function readJsonBody<T extends object>(
    c: Context,
): Promise<Partial<T>> {
    const contentLength = c.req.header("content-length");
    if (contentLength === "0") {
        return {};
    }

    try {
        return (await c.req.json()) ?? {};
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            throw jsonError(
                400,
                "bad_request",
                "Malformed JSON request body.",
            );
        }
        // Hono throws when there is no body; routes with optional JSON treat it as empty.
        if (
            error instanceof Error &&
            error.message.includes("Unexpected end")
        ) {
            return {};
        }
        throw error;
    }
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

    const message = error instanceof Error ? error.message : String(error);
    let statusCode = 500;
    let code = "agent_error";

    if (message.includes("required")) {
        statusCode = 400;
        code = "bad_request";
    }
    else if (message.includes("No loaded session")) {
        statusCode = 404;
        code = "session_not_found";
    }
    else if (message.includes("Loaded session limit reached")) {
        statusCode = 409;
        code = "session_limit_reached";
    }
    else if (message.includes("controlled by another browser client")) {
        statusCode = 409;
        code = "session_control_conflict";
    }
    else if (message.includes("Session is busy")) {
        statusCode = 409;
        code = "session_busy";
    }
    else if (message.includes("Unknown model")) {
        statusCode = 400;
        code = "unknown_model";
    }
    else if (message.includes("Agent is running")) {
        statusCode = 409;
        code = "agent_running";
    }

    return jsonError(statusCode, code, message);
}
