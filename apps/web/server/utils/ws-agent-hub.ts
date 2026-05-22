import type { ClientCommand, ServerEvent } from '../../types/protocol'
import { PiAgentService } from './pi-agent-service'

type Peer = {
  id?: string
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
}

type HubOptions = {
  cwd: string
  approvalTimeoutMs: number
}

export class WsAgentHub {
  private peer?: Peer
  private service?: PiAgentService
  private heartbeat?: NodeJS.Timeout

  constructor(private readonly options: HubOptions) {}

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

  async close(peer: Peer) {
    if (peer !== this.peer) return
    await this.closeActive(true)
  }

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

export function getWsAgentHub(options: HubOptions) {
  hub ??= new WsAgentHub(options)
  return hub
}
