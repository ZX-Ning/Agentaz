import { createError } from 'h3'
import { agentHttpError, getConfiguredAgentRegistry, readJsonBody, requireRouteParam } from '../../../../utils/agent-http'

type ControlRequest = {
  action?: 'acquire' | 'release'
}

export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, 'sessionId')
    const body = await readJsonBody<ControlRequest>(event)
    if (body.action === 'release') {
      return await getConfiguredAgentRegistry().releaseSessionControl(sessionId)
    }
    if (body.action === 'acquire') {
      return await getConfiguredAgentRegistry().acquireSessionControl(sessionId)
    }
    throw createError({
      statusCode: 400,
      statusMessage: 'Control action must be acquire or release.',
      data: { code: 'bad_request', message: 'Control action must be acquire or release.', recoverable: true },
    })
  } catch (error) {
    throw agentHttpError(error)
  }
})
