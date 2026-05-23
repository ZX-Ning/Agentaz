import { agentHttpError, booleanQuery, getConfiguredAgentRegistry, requireRouteParam } from '../../../utils/agent-http'

export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, 'sessionId')
    return await getConfiguredAgentRegistry().closeLoadedSession(sessionId, booleanQuery(event, 'abortCurrent'))
  } catch (error) {
    throw agentHttpError(error)
  }
})
