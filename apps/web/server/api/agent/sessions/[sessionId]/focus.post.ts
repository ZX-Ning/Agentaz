import {
  agentHttpError,
  requireRouteParam,
} from "../../../../utils/agent-http";
import { getAgentRuntime } from "../../../../utils/agent-runtime";
import { LOCAL_CLIENT_ID } from "../../../../utils/client-presence";

export default defineEventHandler(async (event) => {
  try {
    const runtime = getAgentRuntime();
    const sessionId = requireRouteParam(event, "sessionId");
    if (!runtime.workspace.hasSession(sessionId)) {
      throw new Error("No loaded session is available for this command.");
    }
    runtime.presence.focus(LOCAL_CLIENT_ID, sessionId);
    runtime.eventBus.publish({ type: "state_changed" });
    return {
      ...runtime.projector.getState(LOCAL_CLIENT_ID),
      sessionId,
    };
  } catch (error) {
    throw agentHttpError(error);
  }
});
