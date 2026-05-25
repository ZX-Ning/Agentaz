import type { SessionCreateRequest } from "../../../../types/protocol";
import {
  agentHttpError,
  readJsonBody,
} from "../../../utils/agent-http";
import { getAgentRuntime } from "../../../utils/agent-runtime";
import { LOCAL_CLIENT_ID } from "../../../utils/client-presence";

export default defineEventHandler(async (event) => {
  try {
    const body = await readJsonBody<SessionCreateRequest>(event);
    const runtime = getAgentRuntime();
    const controller = body.sessionFile
      ? await runtime.workspace.openLoadedSession(body.sessionFile)
      : await runtime.workspace.createLoadedSession();
    runtime.presence.focus(LOCAL_CLIENT_ID, controller.sessionId);
    runtime.presence.acquireControl(LOCAL_CLIENT_ID, controller.sessionId);
    runtime.eventBus.publish({
      type: "control_changed",
      sessionId: controller.sessionId,
      controlOwnerClientId: runtime.presence.ownerOf(controller.sessionId),
    });
    const state = runtime.projector.getState(LOCAL_CLIENT_ID);
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
