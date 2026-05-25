import {
  agentHttpError,
  requireRouteParam,
  withRequestSessionControl,
} from "../../../../../utils/agent-http";

export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, "sessionId");
    await withRequestSessionControl(event, sessionId, (lease) =>
      lease.runtime.workspace.clearSessionQueue(sessionId),
    );
    return { ok: true, sessionId };
  } catch (error) {
    throw agentHttpError(error);
  }
});
