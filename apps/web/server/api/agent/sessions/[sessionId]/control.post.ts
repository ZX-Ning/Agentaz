import { createError } from "h3";
import {
  agentHttpError,
  readJsonBody,
  requireRouteParam,
} from "../../../../utils/agent-http";
import { getAgentRuntime } from "../../../../utils/agent-runtime";
import { LOCAL_CLIENT_ID } from "../../../../utils/client-presence";

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
    if (body.action === "release") {
      runtime.presence.releaseControl(LOCAL_CLIENT_ID, sessionId);
      runtime.eventBus.publish({
        type: "control_changed",
        sessionId,
        controlOwnerClientId: runtime.presence.ownerOf(sessionId),
      });
      return { ...runtime.projector.getState(LOCAL_CLIENT_ID), sessionId };
    }
    if (body.action === "acquire") {
      runtime.presence.acquireControl(LOCAL_CLIENT_ID, sessionId);
      runtime.eventBus.publish({
        type: "control_changed",
        sessionId,
        controlOwnerClientId: runtime.presence.ownerOf(sessionId),
      });
      return { ...runtime.projector.getState(LOCAL_CLIENT_ID), sessionId };
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
