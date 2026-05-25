import type { SessionCreateRequest } from "../../../../types/protocol";
import {
  agentHttpError,
  getConfiguredAgentRegistry,
  readJsonBody,
} from "../../../utils/agent-http";

export default defineEventHandler(async (event) => {
  try {
    const body = await readJsonBody<SessionCreateRequest>(event);
    if (body.sessionFile) {
      return await getConfiguredAgentRegistry().openLoadedSession(
        body.sessionFile,
      );
    }
    return await getConfiguredAgentRegistry().createLoadedSession();
  } catch (error) {
    throw agentHttpError(error);
  }
});
