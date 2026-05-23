import { agentHttpError, getConfiguredAgentRegistry, requireRouteParam } from '../../../../utils/agent-http'

export default defineEventHandler(async (event) => {
  try {
    return await getConfiguredAgentRegistry().focusLoadedSession(requireRouteParam(event, 'sessionId'))
  } catch (error) {
    throw agentHttpError(error)
  }
})
