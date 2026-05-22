import type { ClientCommand, ServerEvent } from '../../types/protocol'
import { PiAgentService } from './pi-agent-service'

/** Minimal subset of Nitro's WebSocket peer API used by the backend hub. */
type Peer = {
  id?: string
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
}

/** Startup options shared by every WebSocket connection handled by the singleton hub. */
type HubOptions = {
  cwd: string
  approvalTimeoutMs: number
}

/**
 * Owns the single active browser WebSocket connection and its associated Pi agent service.
 *
 * The MVP intentionally permits only one active client because prompts, approvals, and streaming agent
 * output are stateful. The hub rejects concurrent clients unless the new connection requests a force
 * takeover, translates raw WebSocket messages into typed client commands, and ensures approvals are
 * cancelled when the connection goes away.
 */
export class WsAgentHub {
  private peer?: Peer
  private service?: PiAgentService
  private heartbeat?: NodeJS.Timeout

  constructor(private readonly options: HubOptions) {}

  /** Opens a client connection, optionally replacing an existing active browser connection. */
  async open(peer: Peer, force = false) {
    if (this.peer && !force) {
      peer.send(JSON.stringify({ type: 'error', code: 'already_connected', message: 'Another browser client is already connected.', recoverable: true }))
      peer.close(1008, 'already_connected')
      return
    }

    if (this.peer && force) {
      this.peer.send(JSON.stringify({ type: 'error', code: 'client_replaced', message: 'Connection was taken over by another browser client.', recoverable: false }))
      this.peer.close(1000, 'client_replaced')
      await this.closeActive(false)
    }

    this.peer = peer
    this.service = new PiAgentService(this.options.cwd, (event) => this.send(event), this.options.approvalTimeoutMs)

    await this.service.initNewSession()
    this.startHeartbeat()
  }

  /** Parses and dispatches a raw WebSocket command from the active client. */
  async message(peer: Peer, raw: unknown) {
    if (peer !== this.peer) return

    let command: ClientCommand
    try {
      command = JSON.parse(String(raw)) as ClientCommand
    } catch {
      this.sendError('invalid_json', 'WebSocket message is not valid JSON.', true)
      return
    }

    try {
      await this.service?.handleCommand(command)
    } catch (error) {
      console.error('[pi-web] command failed', error)
      this.sendError('command_failed', error instanceof Error ? error.message : String(error), true)
    }
  }

  /** Closes the active client and cancels outstanding browser-backed approvals. */
  async close(peer: Peer) {
    if (peer !== this.peer) return
    await this.closeActive(true)
  }

  /** Logs a WebSocket error and disposes the service if it came from the active client. */
  async error(peer: Peer, error: unknown) {
    console.error('[pi-web] websocket error', error)
    if (peer === this.peer) {
      await this.closeActive(true)
    }
  }

  private send(event: ServerEvent) {
    this.peer?.send(JSON.stringify(event))
  }

  private sendError(code: string, message: string, recoverable: boolean) {
    this.send({ type: 'error', code, message, recoverable })
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      try {
        this.peer?.send(JSON.stringify({ type: 'status', isStreaming: Boolean(this.service?.session?.isStreaming), pendingMessageCount: this.service?.session?.pendingMessageCount ?? 0 }))
      } catch (error) {
        console.error('[pi-web] heartbeat failed', error)
        void this.closeActive(true)
      }
    }, 15_000)
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private async closeActive(cancelApprovals: boolean) {
    this.stopHeartbeat()
    if (cancelApprovals) this.service?.cancelPendingApprovals()
    await this.service?.dispose()
    this.service = undefined
    this.peer = undefined
  }
}

let hub: WsAgentHub | undefined
let hubOptions: HubOptions | undefined

/**
 * Sets the process-wide WebSocket hub configuration before the singleton is read.
 *
 * The first call fixes the runtime configuration for the local MVP. Repeating the call with the same
 * values is allowed so route handlers can be idempotent, but changing values after initialization is a
 * configuration error and must fail loudly instead of silently reusing a hub with stale options.
 */
export function setWsAgentHubConfig(options: HubOptions) {
  if (!hubOptions) {
    hubOptions = options
    return
  }

  if (hubOptions.cwd !== options.cwd || hubOptions.approvalTimeoutMs !== options.approvalTimeoutMs) {
    throw new Error('WsAgentHub configuration cannot be changed after it has been set.')
  }
}

/**
 * Returns the process-wide WebSocket hub used by Nitro route handlers.
 *
 * `setWsAgentHubConfig()` must be called first so callers cannot accidentally create the singleton with
 * ad-hoc options at the usage site.
 */
export function getWsAgentHub() {
  if (!hubOptions) {
    throw new Error('WsAgentHub configuration has not been set.')
  }

  hub ??= new WsAgentHub(hubOptions)
  return hub
}
