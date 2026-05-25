import {
  agentHttpError,
  requestClientId,
  requireRouteParam,
} from "../../../../utils/agent-http";
import { getAgentRuntime } from "../../../../utils/agent-runtime";

export default defineEventHandler(async (event) => {
  try {
    const runtime = getAgentRuntime();
    const sessionId = requireRouteParam(event, "sessionId");
    if (!runtime.workspace.hasSession(sessionId)) {
      throw new Error("No loaded session is available for this command.");
    }
    const clientId = requestClientId(event);
    runtime.presence.focus(clientId, sessionId);
    runtime.eventBus.publish({ type: "state_changed" });
    return {
      ...runtime.projector.getState(clientId),
      sessionId,
    };
  } catch (error) {
    throw agentHttpError(error);
  }
});
