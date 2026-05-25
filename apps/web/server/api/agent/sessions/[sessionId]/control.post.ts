import { createError } from "h3";
import {
  agentHttpError,
  requestClientId,
  readJsonBody,
  requireRouteParam,
} from "../../../../utils/agent-http";
import { getAgentRuntime } from "../../../../utils/agent-runtime";

type ControlRequest = {
  action?: "acquire" | "release";
};

export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, "sessionId");
    const body = await readJsonBody<ControlRequest>(event);
    const runtime = getAgentRuntime();
    if (!runtime.workspace.hasSession(sessionId)) {
      throw new Error("No loaded session is available for this command.");
    }
    const clientId = requestClientId(event);
    if (body.action === "release") {
      runtime.presence.releaseControl(clientId, sessionId);
      runtime.eventBus.publish({
        type: "control_changed",
        sessionId,
        controlOwnerClientId: runtime.presence.ownerOf(sessionId),
      });
      return { ...runtime.projector.getState(clientId), sessionId };
    }
    if (body.action === "acquire") {
      runtime.presence.acquireControl(clientId, sessionId);
      runtime.eventBus.publish({
        type: "control_changed",
        sessionId,
        controlOwnerClientId: runtime.presence.ownerOf(sessionId),
      });
      return { ...runtime.projector.getState(clientId), sessionId };
    }
    throw createError({
      statusCode: 400,
      statusMessage: "Control action must be acquire or release.",
      data: {
        code: "bad_request",
        message: "Control action must be acquire or release.",
        recoverable: true,
      },
    });
  } catch (error) {
    throw agentHttpError(error);
  }
});
