import {
  agentHttpError,
  getConfiguredAgentRegistry,
} from "../../utils/agent-http";

export default defineEventHandler(() => {
  try {
    return getConfiguredAgentRegistry().getDefaultModelState();
  } catch (error) {
    throw agentHttpError(error);
  }
});
