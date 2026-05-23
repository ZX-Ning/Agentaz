import type { ThinkingSetRequest } from '../../../../../types/protocol'
import { agentHttpError, getConfiguredAgentRegistry, readJsonBody, requireRouteParam } from '../../../../utils/agent-http'

export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, 'sessionId')
    const body = await readJsonBody<ThinkingSetRequest>(event)
    if (!body.level) throw new Error('Thinking level is required.')
    return getConfiguredAgentRegistry().setSessionThinkingLevel(sessionId, body.level)
  } catch (error) {
    throw agentHttpError(error)
  }
})
