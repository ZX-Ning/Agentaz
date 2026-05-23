import type { MessageSubmitRequest, MessageSubmitResponse } from '../../../../../types/protocol'
import { agentHttpError, getConfiguredAgentRegistry, readJsonBody, requireRouteParam } from '../../../../utils/agent-http'

export default defineEventHandler(async (event): Promise<MessageSubmitResponse> => {
  try {
    const sessionId = requireRouteParam(event, 'sessionId')
    const body = await readJsonBody<MessageSubmitRequest>(event)
    if (!body.text || !body.mode) throw new Error('Message mode and text are required.')
    getConfiguredAgentRegistry().submitMessage(sessionId, {
      mode: body.mode,
      text: body.text,
      images: body.images,
    })
    return { accepted: true, sessionId }
  } catch (error) {
    throw agentHttpError(error)
  }
})
