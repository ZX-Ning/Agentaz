import {
  AuthStorage,
  createAgentSessionServices,
  ModelRegistry,
  SessionManager,
  type AgentSessionServices,
} from '@earendil-works/pi-coding-agent'
import { resolve } from 'node:path'
import type { AgentCapabilities, AgentStateResponse, MessageSubmitRequest, ModelStateResponse, ServerEvent, SessionOperationResponse, ThinkingLevel, UiRequestResponseRequest, UiSessionSummary } from '../../types/protocol'
import { PROTOCOL_VERSION } from '../../types/protocol'
import {
  DEFAULT_THINKING_LEVELS,
  PiSessionController,
  toUiModel,
  toUiSessionSummary,
  type WsPeer,
} from './pi-session-controller'

export type { WsPeer }

/** Startup options shared by the process-wide session registry. */
type RegistryOptions = {
  cwd: string
  approvalTimeoutMs: number
  maxLoadedSessions: number
}

const LOCAL_CLIENT_ID = 'local-browser'

const CAPABILITIES: AgentCapabilities = {
  steer: true,
  followUp: true,
  clearQueue: true,
  permissions: true,
  modelSelect: true,
  thinkingSelect: true,
  images: false,
  fileTree: false,
  diffViewer: false,
}

/**
 * Process-level owner for loaded Pi sessions and connected browser clients.
 *
 * Sessions remain loaded across focus changes and WebSocket disconnects until the configured
 * loaded-session cap requires evicting one idle, non-active session.
 */
export class PiSessionRegistry {
  private authStorage = AuthStorage.create()
  private modelRegistry = ModelRegistry.create(this.authStorage)
  private servicesPromise?: Promise<AgentSessionServices>
  private sessions = new Map<string, PiSessionController>()
  private clients = new Map<string, WsPeer>()
  private activeSessionByClient = new Map<string, string>()
  private lastActiveSessionId?: string
  private persistedSessionCache: UiSessionSummary[] = []

  constructor(private readonly options: RegistryOptions) {
    void this.getServices().catch((error) => {
      console.error('[pi-web] failed to prewarm Pi SDK services', error)
    })
  }

  /** Returns SDK services shared by all loaded sessions for the configured cwd. */
  private getServices() {
    this.servicesPromise ??= createAgentSessionServices({
      cwd: this.options.cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    }).catch((error) => {
      this.servicesPromise = undefined
      throw error
    })
    return this.servicesPromise
  }

  /** Attaches a browser client and sends its initial session snapshot. */
  async attachClient(peer: WsPeer) {
    const clientId = this.getClientId(peer)
    this.clients.set(clientId, peer)
    const active = this.sessionForClient(clientId, this.lastActiveSessionId, false)
    if (active) {
      this.activeSessionByClient.set(clientId, active.sessionId)
      if (!active.controlledByClientId) {
        active.acquireControl(clientId)
      }
    }
    await this.refreshPersistedSessionCache()
    this.sendHello(clientId)
    this.broadcastSnapshots()
  }

  /** Detaches a browser client without aborting or disposing loaded sessions. */
  detachClient(peer: WsPeer) {
    const clientId = this.getClientId(peer)
    this.clients.delete(clientId)
    this.activeSessionByClient.delete(clientId)
    for (const controller of this.sessions.values()) {
      controller.releaseControl(clientId)
    }
    this.broadcastSnapshots()
  }

  /** Returns the current lightweight backend state for HTTP clients. */
  async getState(clientId = LOCAL_CLIENT_ID): Promise<AgentStateResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      cwd: this.options.cwd,
      activeSessionId: this.activeSessionByClient.get(clientId) ?? this.lastActiveSessionId,
      loadedSessions: this.loadedSessionsFor(clientId),
      persistedSessions: this.persistedSessionCache,
      capabilities: CAPABILITIES,
    }
  }

  /** Creates a fresh loaded session and returns the resulting state snapshot. */
  async createLoadedSession(clientId = LOCAL_CLIENT_ID): Promise<SessionOperationResponse> {
    const controller = await this.createSession(clientId)
    this.broadcastSnapshots()
    return {
      ...(await this.getState(clientId)),
      sessionId: controller.sessionId,
      sessionFile: controller.sessionFile,
    }
  }

  /** Opens a persisted session and returns the resulting state snapshot. */
  async openLoadedSession(sessionFile: string, clientId = LOCAL_CLIENT_ID): Promise<SessionOperationResponse> {
    const controller = await this.openSession(clientId, sessionFile)
    this.broadcastSnapshots()
    return {
      ...(await this.getState(clientId)),
      sessionId: controller.sessionId,
      sessionFile: controller.sessionFile,
    }
  }

  /** Focuses one loaded session and returns the resulting state snapshot. */
  async focusLoadedSession(sessionId: string, clientId = LOCAL_CLIENT_ID): Promise<SessionOperationResponse> {
    const controller = this.focusSession(clientId, sessionId)
    this.broadcastSnapshots()
    return {
      ...(await this.getState(clientId)),
      sessionId: controller.sessionId,
      sessionFile: controller.sessionFile,
    }
  }

  /** Closes one loaded session and returns the remaining state snapshot. */
  async closeLoadedSession(sessionId: string, abortCurrent = false, clientId = LOCAL_CLIENT_ID): Promise<SessionOperationResponse> {
    await this.closeSession(sessionId, abortCurrent)
    await this.refreshPersistedSessionCache()
    this.broadcastSnapshots()
    return this.getState(clientId)
  }

  /** Acquires local UI control for one loaded session and returns the resulting state snapshot. */
  async acquireSessionControl(sessionId: string, clientId = LOCAL_CLIENT_ID): Promise<SessionOperationResponse> {
    this.acquireControl(clientId, sessionId)
    this.broadcastSnapshots()
    return {
      ...(await this.getState(clientId)),
      sessionId,
    }
  }

  /** Releases local UI control for one loaded session and returns the resulting state snapshot. */
  async releaseSessionControl(sessionId: string, clientId = LOCAL_CLIENT_ID): Promise<SessionOperationResponse> {
    this.releaseControl(clientId, sessionId)
    this.broadcastSnapshots()
    return {
      ...(await this.getState(clientId)),
      sessionId,
    }
  }

  /** Returns normalized history for one loaded session. */
  getSessionHistory(sessionId: string) {
    return this.sessionForClient(LOCAL_CLIENT_ID, sessionId).getHistory()
  }

  /** Returns HTTP model/thinking state for one loaded session. */
  getSessionModelState(sessionId: string): ModelStateResponse {
    return this.sessionForClient(LOCAL_CLIENT_ID, sessionId).getModelState()
  }

  /** Returns model picker defaults without creating or initializing a Pi session. */
  getDefaultModelState(): ModelStateResponse {
    return {
      sessionId: '',
      models: this.modelRegistry.getAvailable().map(toUiModel),
      thinkingLevel: 'off',
      availableThinkingLevels: DEFAULT_THINKING_LEVELS,
    }
  }

  /** Sets the model for one loaded session and returns the updated HTTP model state. */
  async setSessionModel(sessionId: string, provider: string, id: string): Promise<ModelStateResponse> {
    const state = await this.mutableSession(sessionId).setModel(provider, id)
    this.broadcastSnapshots()
    return state
  }

  /** Sets the thinking level for one loaded session and returns the updated HTTP model state. */
  async setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<ModelStateResponse> {
    const state = await this.mutableSession(sessionId).setThinkingLevel(level)
    this.broadcastSnapshots()
    return state
  }

  /** Accepts a prompt-like message over HTTP and continues execution asynchronously. */
  submitMessage(sessionId: string, request: MessageSubmitRequest) {
    const controller = this.mutableSession(sessionId)
    const task = request.mode === 'steer'
      ? controller.steer(request.text, request.images)
      : request.mode === 'follow_up'
        ? controller.followUp(request.text, request.images)
        : controller.prompt(request.text, request.images)

    task.catch((error) => {
      console.error('[pi-web] message task failed', error)
      this.broadcast({ type: 'error', code: 'message_failed', message: error instanceof Error ? error.message : String(error), recoverable: true })
    }).finally(async () => {
      await this.refreshPersistedSessionCache()
      this.broadcastSnapshots()
    })
    this.broadcastSnapshots()
  }

  /** Aborts one loaded session and pending browser-backed prompts. */
  async abortSession(sessionId: string) {
    await this.mutableSession(sessionId).abort()
    this.broadcastSnapshots()
  }

  /** Clears queued steer/follow-up messages for one loaded session. */
  async clearSessionQueue(sessionId: string) {
    await this.mutableSession(sessionId).clearQueue()
    this.broadcastSnapshots()
  }

  /** Resolves one browser-backed extension UI request. */
  resolveUiRequest(sessionId: string, requestId: string, response: UiRequestResponseRequest) {
    const controller = this.mutableSession(sessionId)
    if ('confirmed' in response) {
      controller.resolveConfirm(requestId, response.confirmed)
    } else if ('value' in response) {
      controller.resolveInput(requestId, response.value)
    } else {
      controller.resolveSelect(requestId, (response as { selected?: string }).selected)
    }
    this.broadcastSnapshots()
  }

  /** Pushes a lightweight session snapshot to all connected WebSocket subscribers. */
  pushSnapshots() {
    this.broadcastSnapshots()
  }

  /** Disposes every loaded session, used only for process-level teardown. */
  async disposeAll() {
    const controllers = [...this.sessions.values()]
    this.sessions.clear()
    this.activeSessionByClient.clear()
    this.lastActiveSessionId = undefined
    await Promise.all(controllers.map((controller) => controller.dispose()))
  }

  private async createSession(clientId: string) {
    await this.releaseOneAvailableSessionIfAtCapacity()
    this.assertCanLoadAnotherSession()
    const controller = await PiSessionController.create({
      cwd: this.options.cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      getServices: () => this.getServices(),
      send: (event) => this.broadcast(event),
      approvalTimeoutMs: this.options.approvalTimeoutMs,
      onSessionMetadataChanged: () => this.refreshPersistedSessionCache().then(() => this.broadcastSnapshots()),
    })
    this.sessions.set(controller.sessionId, controller)
    controller.acquireControl(clientId)
    this.focusSession(clientId, controller.sessionId)
    return controller
  }

  private async openSession(clientId: string, sessionFile: string) {
    const normalizedSessionFile = resolve(sessionFile)
    const loaded = [...this.sessions.values()].find((controller) => controller.sessionFile && resolve(controller.sessionFile) === normalizedSessionFile)
    if (loaded) {
      this.focusSession(clientId, loaded.sessionId)
      if (!loaded.controlledByClientId) loaded.acquireControl(clientId)
      return loaded
    }

    await this.releaseOneAvailableSessionIfAtCapacity()
    this.assertCanLoadAnotherSession()
    const controller = await PiSessionController.open({
      cwd: this.options.cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      getServices: () => this.getServices(),
      send: (event) => this.broadcast(event),
      approvalTimeoutMs: this.options.approvalTimeoutMs,
      onSessionMetadataChanged: () => this.refreshPersistedSessionCache().then(() => this.broadcastSnapshots()),
      sessionFile: normalizedSessionFile,
    })
    this.sessions.set(controller.sessionId, controller)
    controller.acquireControl(clientId)
    this.focusSession(clientId, controller.sessionId)
    return controller
  }

  private focusSession(clientId: string, sessionId: string) {
    const controller = this.sessionForClient(clientId, sessionId)
    this.activeSessionByClient.set(clientId, sessionId)
    this.lastActiveSessionId = sessionId
    if (clientId === LOCAL_CLIENT_ID) {
      for (const connectedClientId of this.clients.keys()) {
        this.activeSessionByClient.set(connectedClientId, sessionId)
      }
      controller.sendFocusState((event) => this.broadcast(event))
    } else {
      controller.sendFocusState((event) => this.sendToClient(clientId, event))
    }
    return controller
  }

  private acquireControl(clientId: string, sessionId: string) {
    const controller = this.sessionForClient(clientId, sessionId)
    controller.acquireControl(clientId)
    this.broadcastControl(controller)
  }

  private releaseControl(clientId: string, sessionId: string) {
    const controller = this.sessionForClient(clientId, sessionId)
    controller.releaseControl(clientId)
    this.broadcastControl(controller)
  }

  private async closeSession(sessionId: string, abortCurrent = false) {
    const controller = this.mutableSession(sessionId)
    const session = controller.session
    if (session?.isStreaming && !abortCurrent) {
      throw new Error('Agent is running; pass abortCurrent to close the session.')
    }
    if (session?.isStreaming) {
      await controller.abort()
    }

    await controller.dispose()
    this.sessions.delete(sessionId)
    for (const [activeClientId, activeSessionId] of this.activeSessionByClient) {
      if (activeSessionId === sessionId) {
        this.activeSessionByClient.delete(activeClientId)
      }
    }
    if (this.lastActiveSessionId === sessionId) {
      this.lastActiveSessionId = this.sessions.keys().next().value
    }
    if (this.lastActiveSessionId) {
      for (const clientId of this.clients.keys()) {
        this.activeSessionByClient.set(clientId, this.lastActiveSessionId)
      }
      this.activeSessionByClient.set(LOCAL_CLIENT_ID, this.lastActiveSessionId)
    }
  }

  /** Frees one idle, non-active loaded session only when the working set is at capacity. */
  private async releaseOneAvailableSessionIfAtCapacity() {
    if (this.sessions.size < this.options.maxLoadedSessions) return

    const activeSessionIds = new Set(this.activeSessionByClient.values())
    if (this.lastActiveSessionId) activeSessionIds.add(this.lastActiveSessionId)

    for (const [sessionId, controller] of [...this.sessions]) {
      if (activeSessionIds.has(sessionId) || controller.isBusy()) continue
      await controller.dispose()
      this.sessions.delete(sessionId)
      controller.clearControl()
      return
    }
  }

  private mutableSession(sessionId: string) {
    const controller = this.sessionForClient(LOCAL_CLIENT_ID, sessionId)
    if (!controller.controlledByClientId) {
      controller.acquireControl(LOCAL_CLIENT_ID)
      this.broadcastControl(controller)
    }
    return controller
  }

  private sessionForClient(clientId: string, sessionId?: string, required?: true): PiSessionController
  private sessionForClient(clientId: string, sessionId: string | undefined, required: false): PiSessionController | undefined
  private sessionForClient(clientId: string, sessionId?: string, required = true) {
    const resolvedSessionId = sessionId ?? this.activeSessionByClient.get(clientId) ?? this.lastActiveSessionId
    const controller = resolvedSessionId ? this.sessions.get(resolvedSessionId) : undefined
    if (!controller && required) throw new Error('No loaded session is available for this command.')
    return controller
  }

  private sendHello(clientId: string) {
    const activeSessionId = this.activeSessionByClient.get(clientId) ?? this.lastActiveSessionId
    const active = activeSessionId ? this.sessions.get(activeSessionId) : undefined
    this.sendToClient(clientId, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      cwd: this.options.cwd,
      clientId,
      activeSessionId,
      loadedSessions: this.loadedSessionsFor(clientId),
      persistedSessions: this.persistedSessionCache,
      sessionId: active?.sessionId ?? '',
      sessionFile: active?.sessionFile,
      capabilities: CAPABILITIES,
    })
  }

  private async refreshPersistedSessionCache() {
    this.persistedSessionCache = await this.listPersistedSessions()
  }

  private async listPersistedSessions(): Promise<UiSessionSummary[]> {
    const sessions = await SessionManager.list(this.options.cwd)
    return sessions.map(toUiSessionSummary)
  }

  private broadcastSnapshots() {
    for (const clientId of this.clients.keys()) {
      this.sendToClient(clientId, {
        type: 'sessions_snapshot',
        activeSessionId: this.activeSessionByClient.get(clientId),
        loadedSessions: this.loadedSessionsFor(clientId),
        persistedSessions: this.persistedSessionCache,
      })
    }
  }

  private broadcastControl(controller: PiSessionController) {
    for (const clientId of this.clients.keys()) {
      this.sendToClient(clientId, {
        type: 'session_control_changed',
        sessionId: controller.sessionId,
        controlledByClientId: controller.controlledByClientId,
        controlledByThisClient: controller.controlledByClientId === clientId,
      })
    }
  }

  private loadedSessionsFor(clientId: string) {
    return [...this.sessions.values()].map((controller) => controller.toLoadedSession(clientId))
  }

  private broadcast(event: ServerEvent) {
    for (const clientId of this.clients.keys()) {
      this.sendToClient(clientId, event)
    }
  }

  private sendToClient(clientId: string, event: ServerEvent) {
    const peer = this.clients.get(clientId)
    if (!peer) return
    peer.send(JSON.stringify(event))
  }

  private getClientId(peer: WsPeer) {
    if (!peer.id) peer.id = crypto.randomUUID()
    return peer.id
  }

  private assertCanLoadAnotherSession() {
    if (this.sessions.size >= this.options.maxLoadedSessions) {
      throw new Error(`Loaded session limit reached (${this.options.maxLoadedSessions}). Close an idle session before opening another.`)
    }
  }
}

let registry: PiSessionRegistry | undefined
let registryOptions: RegistryOptions | undefined

/** Configures the process-wide session registry before it is used. */
export function setPiSessionRegistryConfig(options: Omit<RegistryOptions, 'maxLoadedSessions'> & { maxLoadedSessions?: number }) {
  const normalized = { ...options, maxLoadedSessions: options.maxLoadedSessions ?? 5 }
  if (!registryOptions) {
    registryOptions = normalized
    return
  }

  if (
    registryOptions.cwd !== normalized.cwd
    || registryOptions.approvalTimeoutMs !== normalized.approvalTimeoutMs
    || registryOptions.maxLoadedSessions !== normalized.maxLoadedSessions
  ) {
    throw new Error('PiSessionRegistry configuration cannot be changed after it has been set.')
  }
}

/** Returns the process-wide registry that owns loaded Pi sessions. */
export function getPiSessionRegistry() {
  if (!registryOptions) {
    throw new Error('PiSessionRegistry configuration has not been set.')
  }
  registry ??= new PiSessionRegistry(registryOptions)
  return registry
}
