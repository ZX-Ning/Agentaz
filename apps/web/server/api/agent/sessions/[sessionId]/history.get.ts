import {
  agentHttpError,
  getConfiguredAgentRegistry,
  requireRouteParam,
} from "../../../../utils/agent-http";

export default defineEventHandler((event) => {
  try {
    return getConfiguredAgentRegistry().getSessionHistory(
      requireRouteParam(event, "sessionId"),
    );
  } catch (error) {
    throw agentHttpError(error);
  }
});
