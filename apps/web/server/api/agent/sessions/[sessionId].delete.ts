import {
  agentHttpError,
  booleanQuery,
  requireRouteParam,
} from "../../../utils/agent-http";
import { getAgentRuntime } from "../../../utils/agent-runtime";
import { LOCAL_CLIENT_ID } from "../../../utils/client-presence";

export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, "sessionId");
    const runtime = getAgentRuntime();
    const fallbackSessionId = await runtime.workspace.closeLoadedSession(
      sessionId,
      booleanQuery(event, "abortCurrent"),
    );
    runtime.presence.removeSession(sessionId, fallbackSessionId);
    runtime.eventBus.publish({ type: "state_changed" });
    return runtime.projector.getState(LOCAL_CLIENT_ID);
  } catch (error) {
    throw agentHttpError(error);
  }
});
