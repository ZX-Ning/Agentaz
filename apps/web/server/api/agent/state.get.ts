import { agentHttpError, requestClientId } from "../../utils/agent-http";
import { getAgentRuntime } from "../../utils/agent-runtime";

export default defineEventHandler(async (event) => {
  try {
    const runtime = getAgentRuntime();
    await runtime.projector.refresh();
    return runtime.projector.getState(requestClientId(event));
  } catch (error) {
    throw agentHttpError(error);
  }
});
