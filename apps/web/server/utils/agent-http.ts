import { createError, getQuery, getRouterParam, readBody, type H3Event } from 'h3'
import { getPiSessionRegistry } from './pi-session-registry'
import { setWsAgentHubConfig } from './ws-agent-hub'

/** Configures and returns the process-wide agent registry for an HTTP or WebSocket request. */
export function getConfiguredAgentRegistry() {
  const config = useRuntimeConfig()
  setWsAgentHubConfig({
    cwd: String(config.piWeb.cwd),
    approvalTimeoutMs: Number(config.piWeb.approvalTimeoutMs),
    maxLoadedSessions: Number(config.piWeb.maxLoadedSessions),
  })
  return getPiSessionRegistry()
}

/** Reads a required route parameter or throws a structured HTTP error. */
export function requireRouteParam(event: H3Event, name: string) {
  const value = getRouterParam(event, name)
  if (!value) {
    throw createError({
      statusCode: 400,
      statusMessage: `Missing route parameter: ${name}`,
      data: { code: 'bad_request', message: `Missing route parameter: ${name}`, recoverable: true },
    })
  }
  return decodeURIComponent(value)
}

/** Reads and type-casts a JSON request body, defaulting missing bodies to an empty object. */
export async function readJsonBody<T extends object>(event: H3Event): Promise<Partial<T>> {
  return (await readBody(event).catch(() => ({}))) ?? {}
}

/** Converts a query flag to a boolean for local agent HTTP endpoints. */
export function booleanQuery(event: H3Event, name: string) {
  const value = getQuery(event)[name]
  return value === '1' || value === 'true'
}

/** Maps registry/runtime errors into consistent HTTP API errors. */
export function agentHttpError(error: unknown) {
  if (typeof error === 'object' && error && 'statusCode' in error) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  let statusCode = 500
  let code = 'agent_error'

  if (message.includes('required')) {
    statusCode = 400
    code = 'bad_request'
  } else if (message.includes('No loaded session')) {
    statusCode = 404
    code = 'session_not_found'
  } else if (message.includes('Loaded session limit reached')) {
    statusCode = 409
    code = 'session_limit_reached'
  } else if (message.includes('Unknown model')) {
    statusCode = 400
    code = 'unknown_model'
  } else if (message.includes('Agent is running')) {
    statusCode = 409
    code = 'agent_running'
  }

  return createError({
    statusCode,
    statusMessage: message,
    data: { code, message, recoverable: statusCode < 500 },
  })
}
