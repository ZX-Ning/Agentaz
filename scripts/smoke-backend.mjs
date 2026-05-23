#!/usr/bin/env node

const httpBaseUrl = process.env.PI_WEB_BASE_URL || 'http://127.0.0.1:3000'
const timeoutMs = Number(process.env.PI_WEB_SMOKE_TIMEOUT_MS || 30_000)

const wsBaseUrl = httpBaseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
const wsUrl = `${wsBaseUrl}/api/agent/ws`

const forbiddenWsEvents = new Set([
  'history',
  'session_changed',
  'session_list_result',
  'model_list_result',
  'model_changed',
  'thinking_changed',
  'message_delta',
  'tool_start',
  'tool_update',
  'tool_end',
])

function logStep(message) {
  console.log(`[smoke] ${message}`)
}

function fail(message, details) {
  console.error(`[smoke] FAIL: ${message}`)
  if (details) console.error(details)
  process.exit(1)
}

function assert(condition, message, details) {
  if (!condition) fail(message, details)
}

async function requestJson(method, path, body) {
  const url = `${httpBaseUrl}${path}`
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => {
    fail(`${method} ${path} is not reachable. Is \`pnpm dev\` running?`, error)
  })

  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : undefined
  } catch {
    fail(`${method} ${path} returned non-JSON`, text)
  }

  if (!response.ok) {
    fail(`${method} ${path} returned HTTP ${response.status}`, JSON.stringify(payload, null, 2))
  }

  return payload
}

function requireSessionId(state, context) {
  assert(typeof state?.activeSessionId === 'string' && state.activeSessionId.length > 0, `${context} did not include activeSessionId`, JSON.stringify(state, null, 2))
  return state.activeSessionId
}

function assertAgentState(state, context) {
  assert(state?.protocolVersion === 3, `${context} protocolVersion should be 3`, JSON.stringify(state, null, 2))
  assert(typeof state.cwd === 'string' && state.cwd.length > 0, `${context} should include cwd`, JSON.stringify(state, null, 2))
  assert(Array.isArray(state.loadedSessions), `${context} should include loadedSessions[]`, JSON.stringify(state, null, 2))
  assert(Array.isArray(state.persistedSessions), `${context} should include persistedSessions[]`, JSON.stringify(state, null, 2))
  assert(state.capabilities?.permissions === true, `${context} should include capabilities`, JSON.stringify(state, null, 2))
}

async function testHealth() {
  logStep('checking health')
  const body = await requestJson('GET', '/api/health')
  assert(body?.ok === true && body?.service === 'pi-web-agent', 'health endpoint returned an unexpected payload', JSON.stringify(body, null, 2))
  logStep('health OK')
}

async function testRestApi() {
  logStep('checking REST state')
  const initialState = await requestJson('GET', '/api/agent/state')
  assertAgentState(initialState, 'initial state')
  const initialSessionId = requireSessionId(initialState, 'initial state')

  logStep(`checking history: ${initialSessionId}`)
  const history = await requestJson('GET', `/api/agent/sessions/${encodeURIComponent(initialSessionId)}/history`)
  assert(history?.sessionId === initialSessionId, 'history response should echo sessionId', JSON.stringify(history, null, 2))
  assert(Array.isArray(history.messages), 'history response should include messages[]', JSON.stringify(history, null, 2))

  logStep(`checking model state: ${initialSessionId}`)
  const models = await requestJson('GET', `/api/agent/sessions/${encodeURIComponent(initialSessionId)}/models`)
  assert(models?.sessionId === initialSessionId, 'models response should echo sessionId', JSON.stringify(models, null, 2))
  assert(Array.isArray(models.models), 'models response should include models[]', JSON.stringify(models, null, 2))
  assert(Array.isArray(models.availableThinkingLevels), 'models response should include availableThinkingLevels[]', JSON.stringify(models, null, 2))

  const thinkingLevel = models.thinkingLevel ?? models.availableThinkingLevels?.[0]
  if (thinkingLevel) {
    logStep(`checking thinking update: ${thinkingLevel}`)
    const updatedThinking = await requestJson('PUT', `/api/agent/sessions/${encodeURIComponent(initialSessionId)}/thinking`, { level: thinkingLevel })
    assert(updatedThinking?.sessionId === initialSessionId, 'thinking update should return model state', JSON.stringify(updatedThinking, null, 2))
  }

  logStep('checking control endpoints')
  await requestJson('POST', `/api/agent/sessions/${encodeURIComponent(initialSessionId)}/control`, { action: 'acquire' })
  await requestJson('POST', `/api/agent/sessions/${encodeURIComponent(initialSessionId)}/control`, { action: 'release' })

  logStep('checking queue/abort endpoints')
  await requestJson('POST', `/api/agent/sessions/${encodeURIComponent(initialSessionId)}/queue/clear`)
  await requestJson('POST', `/api/agent/sessions/${encodeURIComponent(initialSessionId)}/abort`)

  logStep('checking session create/focus/close')
  const created = await requestJson('POST', '/api/agent/sessions', {})
  assertAgentState(created, 'created session response')
  assert(typeof created.sessionId === 'string' && created.sessionId.length > 0, 'session create should return sessionId', JSON.stringify(created, null, 2))

  await requestJson('POST', `/api/agent/sessions/${encodeURIComponent(initialSessionId)}/focus`)
  await requestJson('DELETE', `/api/agent/sessions/${encodeURIComponent(created.sessionId)}?abortCurrent=1`)

  const finalState = await requestJson('GET', '/api/agent/state')
  assertAgentState(finalState, 'final state')
  assert(finalState.loadedSessions.some((session) => session.sessionId === initialSessionId), 'initial session should remain loaded after cleanup', JSON.stringify(finalState, null, 2))

  logStep('REST API OK')
}

async function testWebSocket() {
  logStep(`checking websocket event stream: ${wsUrl}`)

  await new Promise((resolve, reject) => {
    let ws
    const seenEvents = new Set()
    const timer = setTimeout(() => {
      try { ws?.close() } catch {}
      reject(new Error(`timed out after ${timeoutMs}ms; saw events: ${[...seenEvents].join(', ') || '(none)'}`))
    }, timeoutMs)

    ws = new WebSocket(wsUrl)

    ws.addEventListener('open', () => {
      logStep('websocket open')
    })

    ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        clearTimeout(timer)
        ws.close()
        reject(new Error(`received non-JSON websocket message: ${String(event.data)}`))
        return
      }

      if (!message?.type) return
      seenEvents.add(message.type)
      logStep(`event: ${message.type}`)

      if (forbiddenWsEvents.has(message.type)) {
        clearTimeout(timer)
        ws.close()
        reject(new Error(`websocket emitted REST-only event: ${message.type}`))
        return
      }

      if (message.type === 'hello') {
        if (message.protocolVersion !== 3) {
          clearTimeout(timer)
          ws.close()
          reject(new Error(`hello protocolVersion should be 3, got ${message.protocolVersion}`))
          return
        }
      }

      if (seenEvents.has('hello') && seenEvents.has('sessions_snapshot')) {
        clearTimeout(timer)
        ws.close(1000, 'smoke test complete')
        resolve()
      }
    })

    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('websocket connection failed'))
    })

    ws.addEventListener('close', () => {
      if (!seenEvents.has('hello') || !seenEvents.has('sessions_snapshot')) {
        clearTimeout(timer)
        reject(new Error(`websocket closed before required events arrived; saw: ${[...seenEvents].join(', ') || '(none)'}`))
      }
    })
  }).catch((error) => {
    fail('websocket smoke test failed', error)
  })

  logStep('websocket OK')
}

await testHealth()
await testRestApi()
await testWebSocket()

console.log('[smoke] PASS')
