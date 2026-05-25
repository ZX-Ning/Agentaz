import {
  agentHttpError,
  booleanQuery,
  requestClientId,
  requireRouteParam,
} from "../../../utils/agent-http";
import { getAgentRuntime } from "../../../utils/agent-runtime";

export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, "sessionId");
    const runtime = getAgentRuntime();
    const clientId = requestClientId(event);
    const fallbackSessionId = await runtime.workspace.closeLoadedSession(
      sessionId,
      booleanQuery(event, "abortCurrent"),
    );
    runtime.presence.removeSession(sessionId, fallbackSessionId);
    runtime.eventBus.publish({ type: "state_changed" });
    return runtime.projector.getState(clientId);
  } catch (error) {
    throw agentHttpError(error);
  }
});
