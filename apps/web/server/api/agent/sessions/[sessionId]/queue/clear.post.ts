import { agentHttpError, getConfiguredAgentRegistry, requireRouteParam } from '../../../../../utils/agent-http'

export default defineEventHandler((event) => {
  try {
    const sessionId = requireRouteParam(event, 'sessionId')
    getConfiguredAgentRegistry().clearSessionQueue(sessionId)
    return { ok: true, sessionId }
  } catch (error) {
    throw agentHttpError(error)
  }
})
