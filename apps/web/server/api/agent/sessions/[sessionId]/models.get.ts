import {
  agentHttpError,
  getConfiguredAgentRegistry,
  requireRouteParam,
} from "../../../../utils/agent-http";

export default defineEventHandler((event) => {
  try {
    return getConfiguredAgentRegistry().getSessionModelState(
      requireRouteParam(event, "sessionId"),
    );
  } catch (error) {
    throw agentHttpError(error);
  }
});
