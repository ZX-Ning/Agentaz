import type { UiRequestResponseRequest } from "../../../../../../../types/protocol";
import {
  agentHttpError,
  readJsonBody,
  requireRouteParam,
  withRequestSessionControl,
} from "../../../../../../utils/agent-http";

export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, "sessionId");
    const requestId = requireRouteParam(event, "requestId");
    const body = await readJsonBody<UiRequestResponseRequest>(event);
    await withRequestSessionControl(event, sessionId, async (lease) =>
      lease.runtime.workspace.resolveUiRequest(
        sessionId,
        requestId,
        body as UiRequestResponseRequest,
      ),
    );
    return { ok: true, sessionId, requestId };
  } catch (error) {
    throw agentHttpError(error);
  }
});
