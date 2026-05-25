import type { SessionCreateRequest } from "../../../../types/protocol";
import {
  agentHttpError,
  requestClientId,
  readJsonBody,
} from "../../../utils/agent-http";
import { getAgentRuntime } from "../../../utils/agent-runtime";

export default defineEventHandler(async (event) => {
  try {
    const body = await readJsonBody<SessionCreateRequest>(event);
    const runtime = getAgentRuntime();
    const clientId = requestClientId(event);
    const controller = body.sessionFile
      ? await runtime.workspace.openLoadedSession(body.sessionFile)
      : await runtime.workspace.createLoadedSession();
    runtime.presence.focus(clientId, controller.sessionId);
    runtime.presence.acquireControl(clientId, controller.sessionId);
    runtime.eventBus.publish({
      type: "control_changed",
      sessionId: controller.sessionId,
      controlOwnerClientId: runtime.presence.ownerOf(controller.sessionId),
    });
    const state = runtime.projector.getState(clientId);
    if (body.sessionFile) {
      return {
        ...state,
        sessionId: controller.sessionId,
        sessionFile: controller.sessionFile,
      };
    }
    return {
      ...state,
      sessionId: controller.sessionId,
      sessionFile: controller.sessionFile,
    };
  } catch (error) {
    throw agentHttpError(error);
  }
});
