import {
  agentHttpError,
} from "../../utils/agent-http";
import { getAgentRuntime } from "../../utils/agent-runtime";
import { LOCAL_CLIENT_ID } from "../../utils/client-presence";

export default defineEventHandler(async () => {
  try {
    const runtime = getAgentRuntime();
    await runtime.projector.refresh();
    return runtime.projector.getState(LOCAL_CLIENT_ID);
  } catch (error) {
    throw agentHttpError(error);
  }
});
