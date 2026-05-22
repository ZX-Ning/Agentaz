import { getWsAgentHub } from '../../../utils/ws-agent-hub'

export default defineWebSocketHandler({
  async open(peer) {
    const config = useRuntimeConfig()
    const url = new URL(peer.request?.url ?? 'ws://127.0.0.1/api/agent/ws', 'ws://127.0.0.1')
    const force = url.searchParams.get('force') === '1'

    const host = process.env.HOST || '127.0.0.1'
    if (!['127.0.0.1', 'localhost'].includes(host)) {
      console.warn('[pi-web] WARNING: server is listening on a non-localhost host without authentication:', host)
    }

    await getWsAgentHub({
      cwd: String(config.piWeb.cwd),
      approvalTimeoutMs: Number(config.piWeb.approvalTimeoutMs),
    }).open(peer as any, force)
  },

  async message(peer, message) {
    const data = typeof message === 'string' ? message : message.text?.() ?? String(message)
    const config = useRuntimeConfig()
    await getWsAgentHub({
      cwd: String(config.piWeb.cwd),
      approvalTimeoutMs: Number(config.piWeb.approvalTimeoutMs),
    }).message(peer as any, data)
  },

  async close(peer) {
    const config = useRuntimeConfig()
    await getWsAgentHub({
      cwd: String(config.piWeb.cwd),
      approvalTimeoutMs: Number(config.piWeb.approvalTimeoutMs),
    }).close(peer as any)
  },

  async error(peer, error) {
    const config = useRuntimeConfig()
    await getWsAgentHub({
      cwd: String(config.piWeb.cwd),
      approvalTimeoutMs: Number(config.piWeb.approvalTimeoutMs),
    }).error(peer as any, error)
  },
})
