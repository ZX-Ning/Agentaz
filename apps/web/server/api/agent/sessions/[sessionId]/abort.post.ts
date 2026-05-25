import {
  agentHttpError,
  getConfiguredAgentRegistry,
  requireRouteParam,
} from "../../../../utils/agent-http";

export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, "sessionId");
    await getConfiguredAgentRegistry().abortSession(sessionId);
    return { ok: true, sessionId };
  } catch (error) {
    throw agentHttpError(error);
  }
});
