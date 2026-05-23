import { agentHttpError, getConfiguredAgentRegistry, requireRouteParam } from '../../../../../utils/agent-http'

export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, 'sessionId')
    await getConfiguredAgentRegistry().clearSessionQueue(sessionId)
    return { ok: true, sessionId }
  } catch (error) {
    throw agentHttpError(error)
  }
})
