import type { ModelSetRequest } from "../../../../../types/protocol";
import {
  agentHttpError,
  readJsonBody,
  requireRouteParam,
  withRequestSessionControl,
} from "../../../../utils/agent-http";

export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, "sessionId");
    const body = await readJsonBody<ModelSetRequest>(event);
    if (!body.provider || !body.id)
      throw new Error("Model provider and id are required.");
    return await withRequestSessionControl(event, sessionId, (lease) =>
      lease.runtime.workspace.setSessionModel(
        sessionId,
        body.provider!,
        body.id!,
      ),
    );
  } catch (error) {
    throw agentHttpError(error);
  }
});
