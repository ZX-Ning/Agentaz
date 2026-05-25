import {
  createError,
  getHeader,
  getRouterParam,
  readBody,
  type H3Event,
} from "h3";
import { getAgentRuntime } from "./agent-runtime";
import { LOCAL_CLIENT_ID } from "./client-presence";

const CLIENT_ID_HEADER = "x-agentaz-client-id";

/** Configures and returns the process-wide Pi session workspace for an HTTP request. */
export function getConfiguredAgentRegistry() {
  return getAgentRuntime().workspace;
}

/** Reads the browser tab client id carried by HTTP requests, falling back for non-WS callers. */
export function requestClientId(event: H3Event) {
  const clientId = getHeader(event, CLIENT_ID_HEADER);
  return clientId?.trim() || LOCAL_CLIENT_ID;
}

/** Acquires a request-scoped session control lease and returns a release callback. */
export function acquireRequestSessionControl(event: H3Event, sessionId: string) {
  const runtime = getAgentRuntime();
  if (!runtime.workspace.hasSession(sessionId)) {
    throw new Error("No loaded session is available for this command.");
  }
  const clientId = requestClientId(event);
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

/** Reads a required route parameter or throws a structured HTTP error. */
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

/** Reads and type-casts a JSON request body, defaulting missing bodies to an empty object. */
export async function readJsonBody<T extends object>(
  event: H3Event,
): Promise<Partial<T>> {
  return (await readBody(event).catch(() => ({}))) ?? {};
}

/** Maps registry/runtime errors into consistent HTTP API errors. */
export function agentHttpError(error: unknown) {
  if (typeof error === "object" && error && "statusCode" in error) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  let statusCode = 500;
  let code = "agent_error";

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
