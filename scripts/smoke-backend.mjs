#!/usr/bin/env node

const httpBaseUrl = process.env.PI_WEB_BASE_URL || 'http://127.0.0.1:3000'
const timeoutMs = Number(process.env.PI_WEB_SMOKE_TIMEOUT_MS || 30_000)
const force = process.env.PI_WEB_WS_FORCE !== '0'

const wsBaseUrl = httpBaseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
const wsUrl = `${wsBaseUrl}/api/agent/ws${force ? '?force=1' : ''}`

const requiredEvents = new Set(['hello', 'history', 'model_list_result', 'session_list_result'])
const seenEvents = new Set()
const messages = []

function logStep(message) {
  console.log(`[smoke] ${message}`)
}

function fail(message, details) {
  console.error(`[smoke] FAIL: ${message}`)
  if (details) console.error(details)
  process.exit(1)
}

async function testHealth() {
  const url = `${httpBaseUrl}/api/health`
  logStep(`checking health: ${url}`)

  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    fail('health endpoint is not reachable. Is `pnpm dev` running?', error)
  }

  if (!response.ok) {
    fail(`health endpoint returned HTTP ${response.status}`, await response.text())
  }

  const body = await response.json()
  if (body?.ok !== true || body?.service !== 'pi-web-agent') {
    fail('health endpoint returned an unexpected payload', JSON.stringify(body, null, 2))
  }

  logStep('health OK')
}

async function testWebSocket() {
  logStep(`connecting websocket: ${wsUrl}`)

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error(`timed out after ${timeoutMs}ms; saw events: ${[...seenEvents].join(', ') || '(none)'}`))
    }, timeoutMs)

    const ws = new WebSocket(wsUrl)

    ws.addEventListener('open', () => {
      logStep('websocket open')
      ws.send(JSON.stringify({ type: 'session_list' }))
      ws.send(JSON.stringify({ type: 'model_list' }))
    })

    ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch (error) {
        clearTimeout(timer)
        ws.close()
        reject(new Error(`received non-JSON websocket message: ${String(event.data)}`))
        return
      }

      messages.push(message)
      if (message?.type) {
        seenEvents.add(message.type)
        logStep(`event: ${message.type}`)
      }

      if (message?.type === 'error') {
        clearTimeout(timer)
        ws.close()
        reject(new Error(`server error event: ${message.code}: ${message.message}`))
        return
      }

      const missing = [...requiredEvents].filter((type) => !seenEvents.has(type))
      if (missing.length === 0) {
        clearTimeout(timer)
        ws.close(1000, 'smoke test complete')
        resolve()
      }
    })

    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('websocket connection failed'))
    })

    ws.addEventListener('close', (event) => {
      const missing = [...requiredEvents].filter((type) => !seenEvents.has(type))
      if (missing.length > 0) {
        clearTimeout(timer)
        reject(new Error(`websocket closed before required events arrived; missing: ${missing.join(', ')}`))
      }
    })
  }).catch((error) => {
    fail('websocket smoke test failed', error)
  })

  logStep('websocket OK')
}

await testHealth()
await testWebSocket()

console.log('[smoke] PASS')
