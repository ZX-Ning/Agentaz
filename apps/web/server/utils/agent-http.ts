import {
  createError,
  getHeader,
  getRouterParam,
  readBody,
  type H3Event,
} from "h3";
import type { UiRequestResponseRequest } from "../../types/protocol";
import { getAgentRuntime } from "./agent-runtime";
import { LOCAL_CLIENT_ID } from "./client-presence";
import {
  AgentazDomainError,
  BadRequestError,
  SessionNotFoundError,
} from "./domain-errors";

/** Header name for the browser-tab client identity carried on every HTTP request. */
const CLIENT_ID_HEADER = "x-agentaz-client-id";

/**
 * Returns the shared PiSessionWorkspace for use in HTTP route handlers.
 * Convenience accessor that avoids importing agent-runtime in every route file.
 */
export function getConfiguredAgentRegistry() {
  return getAgentRuntime().workspace;
}

/**
 * Reads the browser tab client id from the x-agentaz-client-id request header.
 *
 * Each browser tab sends a unique client id so the backend can track which tab
 * is focused on which session and which tab holds session mutation control.
 * When the header is absent (e.g. programmatic API calls or curl), falls back
 * to LOCAL_CLIENT_ID ("local-browser") so the local-first default works.
 */
export function requestClientId(event: H3Event) {
  const clientId = getHeader(event, CLIENT_ID_HEADER);
  return clientId?.trim() || LOCAL_CLIENT_ID;
}

/**
 * Acquires a request-scoped session mutation lease and publishes control change events.
 *
 * This is the core concurrency primitive for HTTP-driven session mutations.
 * It ensures only one browser client can mutate a session at a time — if another
 * client already holds the control lease for this session, the request is rejected.
 *
 * Returns a lease object with:
 *   - runtime: The process-wide AgentRuntime singleton
 *   - clientId: The calling client's identity
 *   - release(): Call this to relinquish control (publishes control_changed on release)
 *
 * Callers must always call release(), even on error paths. Prefer withRequestSessionControl
 * for try/finally safety.
 */
export function acquireRequestSessionControl(
  event: H3Event,
  sessionId: string,
) {
  const runtime = getAgentRuntime();

  // Validate the session exists before attempting to acquire control.
  if (!runtime.workspace.hasSession(sessionId)) {
    throw new SessionNotFoundError();
  }

  const clientId = requestClientId(event);

  // Acquire the control lease — throws SessionControlConflict if another
  // client already owns it.
  runtime.presence.acquireControl(clientId, sessionId);

  // Broadcast control ownership so connected browsers see the new lease owner.
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

/**
 * Runs a short session mutation while holding request-scoped session control.
 *
 * Acquires a control lease, executes the provided async function, and releases
 * the lease in a finally block — guaranteeing cleanup even if the function throws.
 * This is the preferred pattern over manual acquire/release to avoid leaked leases.
 */
export async function withRequestSessionControl<T>(
  event: H3Event,
  sessionId: string,
  run: (lease: ReturnType<typeof acquireRequestSessionControl>) => Promise<T>,
) {
  const lease = acquireRequestSessionControl(event, sessionId);
  try {
    return await run(lease);
  } finally {
    lease.release();
  }
}

/**
 * Reads a required route parameter or throws a structured 400 HTTP error.
 *
 * Route parameters come from the URL path (e.g. :sessionId in /api/agent/sessions/:sessionId/...).
 * The value is URI-decoded so that encoded special characters in paths are properly restored.
 *
 * @throws H3Error with statusCode 400 and code "bad_request" if the parameter is missing
 */
export function requireRouteParam(event: H3Event, name: string) {
  const value = getRouterParam(event, name);
  if (!value) {
    throw createError({
      statusCode: 400,
      statusMessage: `Missing route parameter: ${name}`,
      data: {
        code: "bad_request",
        message: `Missing route parameter: ${name}`,
        recoverable: true,
      },
    });
  }
  return decodeURIComponent(value);
}

/**
 * Reads and type-casts a JSON request body, defaulting missing bodies to an empty object.
 *
 * Uses h3's readBody() which handles JSON parsing. Empty bodies return {} so
 * routes with optional JSON bodies can still destructure safely. Malformed JSON
 * is rejected with 400 instead of being treated as an empty object.
 * The returned Partial<T> means all fields are optional — individual routes must
 * validate required fields themselves.
 */
export async function readJsonBody<T extends object>(
  event: H3Event,
): Promise<Partial<T>> {
  try {
    return (await readBody(event)) ?? {};
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage: "Malformed JSON request body.",
      data: {
        code: "bad_request",
        message: "Malformed JSON request body.",
        recoverable: true,
      },
    });
  }
}

/**
 * Validates and normalizes a browser-backed extension UI response body.
 *
 * The wire protocol uses an explicit kind discriminator so malformed bodies do
 * not accidentally fall through to the select resolver. This parser enforces
 * the per-kind payload shape before workspace code resolves the pending prompt.
 *
 * @throws BadRequestError when the response kind or payload is invalid
 */
export function parseUiRequestResponse(
  body: Partial<UiRequestResponseRequest>,
): UiRequestResponseRequest {
  if (body.kind === "confirm") {
    if (typeof body.confirmed !== "boolean") {
      throw new BadRequestError("Confirm UI responses require confirmed.");
    }
    return { kind: "confirm", confirmed: body.confirmed };
  }

  if (body.kind === "input") {
    if (body.value !== undefined && typeof body.value !== "string") {
      throw new BadRequestError("Input UI response value must be a string.");
    }
    return { kind: "input", value: body.value };
  }

  if (body.kind === "select") {
    if (body.selected !== undefined && typeof body.selected !== "string") {
      throw new BadRequestError(
        "Select UI response selected value must be a string.",
      );
    }
    return { kind: "select", selected: body.selected };
  }

  throw new BadRequestError("UI response kind is required.");
}

/**
 * Maps registry/runtime errors into consistent HTTP API errors with structured data.
 *
 * This function is the single error normalization point for all agent HTTP routes.
 * It classifies errors by message substring into HTTP status codes and error codes
 * that the frontend can display and handle:
 *
 *   - 400 BAD_REQUEST: Missing required fields, unknown model references
 *   - 404 SESSION_NOT_FOUND: Session not loaded in the workspace
 *   - 409 CONFLICT: Session limit reached, control conflict, agent already running
 *   - 500 AGENT_ERROR: Unexpected internal errors (default)
 *
 * If the error is already an H3 error (has statusCode), it passes through unchanged.
 * All errors include a recoverable flag (true for 4xx, false for 5xx) that the
 * frontend uses to decide whether to show a retry UI.
 */
export function agentHttpError(error: unknown) {
  if (error instanceof AgentazDomainError) {
    return createError({
      statusCode: error.statusCode,
      statusMessage: error.message,
      data: error.data,
    });
  }

  // Pass through existing H3 errors (already structured).
  if (typeof error === "object" && error && "statusCode" in error) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  let statusCode = 500;
  let code = "agent_error";

  // Classify by message keywords — Pi SDK and workspace errors use
  // consistent English messages so substring matching is reliable.
  if (message.includes("required")) {
    statusCode = 400;
    code = "bad_request";
  } else if (message.includes("No loaded session")) {
    statusCode = 404;
    code = "session_not_found";
  } else if (message.includes("Loaded session limit reached")) {
    statusCode = 409;
    code = "session_limit_reached";
  } else if (message.includes("controlled by another browser client")) {
    statusCode = 409;
    code = "session_control_conflict";
  } else if (message.includes("Session is busy")) {
    statusCode = 409;
    code = "session_busy";
  } else if (message.includes("Unknown model")) {
    statusCode = 400;
    code = "unknown_model";
  } else if (message.includes("Agent is running")) {
    statusCode = 409;
    code = "agent_running";
  }

  return createError({
    statusCode,
    statusMessage: message,
    data: { code, message, recoverable: statusCode < 500 },
  });
}
