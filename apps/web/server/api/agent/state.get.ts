import { agentHttpError, getConfiguredAgentRegistry } from '../../utils/agent-http'

export default defineEventHandler(async () => {
  try {
    return await getConfiguredAgentRegistry().getState()
  } catch (error) {
    throw agentHttpError(error)
  }
})
