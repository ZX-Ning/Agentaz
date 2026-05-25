import {
  AuthStorage,
  createAgentSessionFromServices,
  type AgentSessionServices,
  type CreateAgentSessionResult,
} from '@earendil-works/pi-coding-agent'
import { ModelRegistry, SessionManager } from '@earendil-works/pi-coding-agent'
import type { ImagePayload, ModelStateResponse, ServerEvent, SessionHistoryResponse, ThinkingLevel, UiBlock, UiLoadedSession, UiMessage, UiModel, UiSessionSummary } from '../../types/protocol'
import { WebExtensionUIContext } from './extension-ui-context'
import { ensurePermissionConfig } from './permission-config'

/** Minimal WebSocket peer surface needed by the session registry. */
export type WsPeer = {
  id?: string
  send: (data: string) => void
}

/** Emits a normalized server event to connected browser clients. */
export type SendEvent = (event: ServerEvent) => void

/** Model and thinking-level changes requested while a session is still busy. */
type PendingSettings = {
  model?: any
  thinkingLevel?: ThinkingLevel
}

/** Runtime location of a tool call block in the canonical transcript projection. */
type ToolBlockLocation = {
  messageId: string
  callBlockId: string
  resultBlockId: string
}

export const DEFAULT_THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

/**
 * Owns one live Pi SDK session and its browser-facing integration.
 *
 * A controller is independent from WebSocket connection lifetime. It keeps streaming, queue,
 * model/thinking state, extension UI prompts, and event subscriptions alive until the registry
 * explicitly closes or disposes the loaded session.
 */
export class PiSessionController {
  private sessionResult?: CreateAgentSessionResult
  private sessionManager?: SessionManager
  private initPromise?: Promise<void>
  private unsubscribe?: () => void
  private uiContext?: WebExtensionUIContext
  private pendingSettings: PendingSettings = {}
  private _controlledByClientId?: string
  private currentAssistantMessageId: string = crypto.randomUUID()
  private currentTextBlockId?: string
  private currentThinkingBlockId?: string
  private transcript = new Map<string, UiMessage>()
  private toolBlocks = new Map<string, ToolBlockLocation>()
  private anonymousToolCallId?: string
  private anonymousToolCallCounter = 0
  private cachedHistory?: SessionHistoryResponse

  private constructor(
    private readonly cwd: string,
    private readonly authStorage: ReturnType<typeof AuthStorage.create>,
    private readonly modelRegistry: ReturnType<typeof ModelRegistry.create>,
    private readonly getServices: () => Promise<AgentSessionServices>,
    private readonly send: SendEvent,
    private readonly approvalTimeoutMs: number,
    private readonly onSessionMetadataChanged: () => void | Promise<void>,
  ) {}

  /** Creates a fresh persisted session for the configured working directory. */
  static async create(options: {
    cwd: string
    authStorage: ReturnType<typeof AuthStorage.create>
    modelRegistry: ReturnType<typeof ModelRegistry.create>
    getServices: () => Promise<AgentSessionServices>
    send: SendEvent
    approvalTimeoutMs: number
    onSessionMetadataChanged: () => void | Promise<void>
  }) {
    const controller = new PiSessionController(options.cwd, options.authStorage, options.modelRegistry, options.getServices, options.send, options.approvalTimeoutMs, options.onSessionMetadataChanged)
    const sessionManager = SessionManager.create(options.cwd)
    sessionManager.newSession()
    await controller.init(sessionManager)
    return controller
  }

  /** Opens an existing persisted session file for the configured working directory. */
  static async open(options: {
    cwd: string
    authStorage: ReturnType<typeof AuthStorage.create>
    modelRegistry: ReturnType<typeof ModelRegistry.create>
    getServices: () => Promise<AgentSessionServices>
    send: SendEvent
    approvalTimeoutMs: number
    onSessionMetadataChanged: () => void | Promise<void>
    sessionFile: string
  }) {
    const controller = new PiSessionController(options.cwd, options.authStorage, options.modelRegistry, options.getServices, options.send, options.approvalTimeoutMs, options.onSessionMetadataChanged)
    controller.sessionManager = SessionManager.open(options.sessionFile, undefined, options.cwd)
    return controller
  }

  /** Returns the live Pi SDK session owned by this controller. */
  get session() {
    return this.sessionResult?.session
  }

  /** Stable Pi session identifier used for protocol routing. */
  get sessionId() {
    return this.session?.sessionId ?? this.requireSessionManager().getSessionId()
  }

  /** Current session file path for persisted sessions. */
  get sessionFile() {
    return this.session?.sessionFile ?? this.requireSessionManager().getSessionFile()
  }

  /** Current client that may mutate this session, if any. */
  get controlledByClientId() {
    return this._controlledByClientId
  }

  /** Acquires mutation control for a client unless another connected client owns it. */
  acquireControl(clientId: string) {
    if (this._controlledByClientId && this._controlledByClientId !== clientId) {
      throw new Error('Session is controlled by another browser client.')
    }
    this._controlledByClientId = clientId
  }

  /** Releases mutation control if it is currently owned by the given client. */
  releaseControl(clientId: string) {
    if (this._controlledByClientId === clientId) {
      this._controlledByClientId = undefined
    }
  }

  /** Releases mutation control regardless of owner. */
  clearControl() {
    this._controlledByClientId = undefined
  }

  /** Returns whether the session must remain loaded because work is still in flight. */
  isBusy() {
    return Boolean(this.initPromise) || this.isWorkflowBusy() || (this.uiContext?.pendingCount ?? 0) > 0
  }

  /** Converts this loaded session into a browser sidebar/status row. */
  toLoadedSession(_clientId: string): UiLoadedSession {
    const session = this.session
    const sessionId = this.sessionId
    const sessionFile = this.sessionFile
    const summary = summarizeSessionManager(this.requireSessionManager())
    return {
      file: sessionFile ?? sessionId,
      ...summary,
      sessionId,
      sessionFile,
      isWorking: this.isBusy(),
      isStreaming: session?.isStreaming ?? false,
      pendingMessageCount: session?.pendingMessageCount ?? 0,
      pendingApprovalCount: this.uiContext?.pendingCount ?? 0,
      controlledByClientId: this._controlledByClientId,
      controlledByThisClient: this._controlledByClientId === _clientId,
    }
  }

  /** Sends a prompt to this session and waits for the Pi agent loop to finish. */
  async prompt(text: string, images?: ImagePayload[]) {
    await this.ensureInitialized()
    await this.requireSession().prompt(text, { images: toPiImages(images) })
  }

  /** Sends steering text to the currently streaming session. */
  async steer(text: string, images?: ImagePayload[]) {
    await this.ensureInitialized()
    await this.requireSession().prompt(text, { images: toPiImages(images), streamingBehavior: 'steer' })
  }

  /** Queues a follow-up prompt for the currently streaming session. */
  async followUp(text: string, images?: ImagePayload[]) {
    await this.ensureInitialized()
    await this.requireSession().prompt(text, { images: toPiImages(images), streamingBehavior: 'followUp' })
  }

  /** Aborts the active agent operation and pending browser-backed UI prompts. */
  async abort() {
    await this.ensureInitialized()
    this.uiContext?.cancelAll()
    await this.requireSession().abort()
    this.sendStatus()
  }

  /** Clears queued steering and follow-up messages. */
  async clearQueue() {
    await this.ensureInitialized()
    const cleared = this.requireSession().clearQueue()
    this.send({ type: 'queue_update', sessionId: this.sessionId, steering: [], followUp: [] })
    this.sendStatus()
    console.log('[pi-web] cleared queue', cleared)
  }

  /** Returns the model list and current model state for this session. */
  getModelState(): ModelStateResponse {
    const session = this.session
    const restored = session ? undefined : this.requireSessionManager().buildSessionContext()
    const restoredModel = restored?.model ? this.modelRegistry.find(restored.model.provider, restored.model.modelId) : undefined
    return {
      sessionId: this.sessionId,
      models: this.modelRegistry.getAvailable().map(toUiModel),
      current: session?.model ? toUiModel(session.model) : restoredModel ? toUiModel(restoredModel) : undefined,
      thinkingLevel: session?.thinkingLevel ?? normalizeThinkingLevel(restored?.thinkingLevel),
      availableThinkingLevels: session?.getAvailableThinkingLevels() ?? DEFAULT_THINKING_LEVELS,
      pendingModel: this.pendingSettings.model ? toUiModel(this.pendingSettings.model) : undefined,
      pendingThinkingLevel: this.pendingSettings.thinkingLevel,
    }
  }

  /** Sets the model immediately or queues it until the session is idle. */
  async setModel(provider: string, id: string) {
    await this.ensureInitialized()
    const model = this.modelRegistry.find(provider, id)
    if (!model) throw new Error(`Unknown model: ${provider}/${id}`)

    const session = this.requireSession()
    if (this.isWorkflowBusy()) {
      this.pendingSettings.model = model
      return this.getModelState()
    }

    await session.setModel(model)
    return this.getModelState()
  }

  /** Sets the thinking level immediately or queues it until the session is idle. */
  async setThinkingLevel(level: ThinkingLevel) {
    await this.ensureInitialized()
    const session = this.requireSession()
    if (this.isWorkflowBusy()) {
      this.pendingSettings.thinkingLevel = level
      return this.getModelState()
    }

    session.setThinkingLevel(level)
    return this.getModelState()
  }

  /** Resolves a browser-backed select prompt for this session. */
  resolveSelect(requestId: string, selected?: string) {
    this.uiContext?.resolveSelect(requestId, selected)
    this.sendStatus()
  }

  /** Resolves a browser-backed input prompt for this session. */
  resolveInput(requestId: string, value?: string) {
    this.uiContext?.resolveInput(requestId, value)
    this.sendStatus()
  }

  /** Resolves a browser-backed confirmation prompt for this session. */
  resolveConfirm(requestId: string, confirmed: boolean) {
    this.uiContext?.resolveConfirm(requestId, confirmed)
    this.sendStatus()
  }

  /** Releases subscriptions, pending prompts, and the underlying SDK session. */
  async dispose() {
    this.uiContext?.cancelAll()
    this.unsubscribe?.()
    this.requireSession(false)?.dispose()
  }

  /** Returns normalized history, caching the result until messages change. */
  getHistory(): SessionHistoryResponse {
    if (this.cachedHistory) return this.cachedHistory
    const session = this.session
    const messages = session?.messages ?? this.requireSessionManager().buildSessionContext().messages
    this.cachedHistory = {
      sessionId: this.sessionId,
      messages: normalizeMessages(messages as any[]),
    }
    return this.cachedHistory
  }

  /** Invalidates the cached history when session messages change. */
  private invalidateHistoryCache() {
    this.cachedHistory = undefined
  }

  /** Sends lightweight active-session and status events for a focused loaded session. */
  sendFocusState(send: SendEvent = this.send) {
    send({ type: 'active_session_changed', sessionId: this.sessionId, sessionFile: this.sessionFile })
    this.sendStatus(send)
  }

  private async init(sessionManager: SessionManager) {
    this.sessionManager = sessionManager
    await this.ensureInitialized()
  }

  private async ensureInitialized() {
    if (this.sessionResult) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this.initializeSession()
    try {
      await this.initPromise
    } finally {
      this.initPromise = undefined
    }
  }

  private async initializeSession() {
    await ensurePermissionConfig(this.cwd)

    this.sessionResult = await createAgentSessionFromServices({
      services: await this.getServices(),
      sessionManager: this.requireSessionManager(),
    })

    const session = this.requireSession()
    this.uiContext = new WebExtensionUIContext(session.sessionId, this.send, this.approvalTimeoutMs)
    await session.bindExtensions({
      uiContext: this.uiContext as any,
      onError: (error) => {
        console.error('[pi-web] extension error', error)
        this.send({ type: 'error', code: 'extension_error', message: error instanceof Error ? error.message : String(error), recoverable: true })
      },
    })

    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event as any))
  }

  private async applyPendingSettingsIfIdle() {
    const session = this.session
    if (!session || this.isWorkflowBusy()) return

    const { model, thinkingLevel } = this.pendingSettings
    this.pendingSettings = {}

    if (model) {
      await session.setModel(model)
    }
    if (thinkingLevel) {
      session.setThinkingLevel(thinkingLevel)
    }
  }

  private onSessionEvent(event: any) {
    try {
      const sessionId = this.sessionId
      switch (event.type) {
        case 'message_update':
          this.forwardMessageUpdate(sessionId, event)
          this.invalidateHistoryCache()
          break
        case 'tool_execution_start':
        case 'tool_start':
          this.upsertToolCallBlock(sessionId, event, 'pending')
          this.invalidateHistoryCache()
          break
        case 'tool_execution_update':
        case 'tool_update':
          this.upsertToolCallBlock(sessionId, event, 'running')
          this.invalidateHistoryCache()
          break
        case 'tool_execution_end':
        case 'tool_end':
          this.completeToolCallBlock(sessionId, event)
          this.invalidateHistoryCache()
          break
        case 'queue_update':
          this.send({ type: 'queue_update', sessionId, steering: [...event.steering], followUp: [...event.followUp] })
          this.sendStatus()
          void this.applyPendingSettingsIfIdle()
          break
        case 'agent_end':
          this.sendStatus()
          this.flushCurrentAssistantMessage(sessionId)
          this.currentAssistantMessageId = crypto.randomUUID()
          this.currentTextBlockId = undefined
          this.currentThinkingBlockId = undefined
          this.toolBlocks.clear()
          this.anonymousToolCallId = undefined
          void this.applyPendingSettingsIfIdle()
          this.invalidateHistoryCache()
          break
        case 'thinking_level_changed':
          this.sendStatus()
          break
        case 'session_info_changed':
          void this.notifySessionMetadataChanged()
          break
      }
    } catch (error) {
      console.error('[pi-web] failed to forward session event', error)
    }
  }

  private async notifySessionMetadataChanged() {
    try {
      await this.onSessionMetadataChanged()
    } catch (error) {
      console.error('[pi-web] failed to refresh session metadata', error)
    }
  }

  private forwardMessageUpdate(sessionId: string, event: any) {
    const messageEvent = event.assistantMessageEvent ?? event.messageEvent ?? event
    if (messageEvent.type === 'text_delta') {
      this.appendAssistantBlockDelta(sessionId, event.messageId, 'text', messageEvent.delta ?? '')
    }
    if (messageEvent.type === 'thinking_delta') {
      this.appendAssistantBlockDelta(sessionId, event.messageId, 'thinking', messageEvent.delta ?? '')
    }
  }

  private appendAssistantBlockDelta(sessionId: string, messageId: string | undefined, blockType: 'text' | 'thinking', delta: string) {
    const message = this.ensureAssistantMessage(sessionId, messageId)
    const block = blockType === 'text'
      ? this.ensureTextBlock(sessionId, message)
      : this.ensureThinkingBlock(sessionId, message)
    block.text += delta
    this.send({ type: 'message_block_delta', sessionId, messageId: message.id, blockId: block.id, blockType, delta })
  }

  private upsertToolCallBlock(sessionId: string, event: any, status: Extract<UiBlock, { type: 'tool_call' }>['status']) {
    const toolCallId = this.toolCallId(event, status === 'pending' ? 'start' : 'update')
    const location = this.ensureToolBlockLocation(sessionId, toolCallId)
    const message = this.ensureAssistantMessage(sessionId, location.messageId)
    const existing = findToolCallBlock(message, toolCallId) ?? message.blocks.find((block): block is Extract<UiBlock, { type: 'tool_call' }> => block.id === location.callBlockId && block.type === 'tool_call')
    const block: UiBlock = {
      id: location.callBlockId,
      type: 'tool_call',
      toolCallId,
      toolName: event.toolName ?? event.name ?? event.tool ?? existing?.toolName ?? 'tool',
      input: extractToolInput(event) ?? existing?.input,
      status,
    }
    this.upsertBlock(message, block)
    this.send({ type: 'message_block_upsert', sessionId, messageId: message.id, block })
  }

  private completeToolCallBlock(sessionId: string, event: any) {
    const isError = Boolean(event.isError ?? event.error)
    this.upsertToolCallBlock(sessionId, event, isError ? 'error' : 'completed')

    const toolCallId = this.toolCallId(event, 'end')
    const location = this.ensureToolBlockLocation(sessionId, toolCallId)
    const message = this.ensureAssistantMessage(sessionId, location.messageId)
    const summary = summarizeToolResult(event.result ?? event.output ?? event.error)
    const resultBlock: UiBlock = {
      id: location.resultBlockId,
      type: 'tool_result',
      toolCallId,
      content: summary,
      isError,
    }
    this.upsertBlock(message, resultBlock)
    this.send({ type: 'message_block_upsert', sessionId, messageId: message.id, block: resultBlock })
    if (!extractToolCallId(event) && this.anonymousToolCallId === toolCallId) {
      this.anonymousToolCallId = undefined
    }
  }

  private ensureAssistantMessage(sessionId: string, messageId = this.currentAssistantMessageId) {
    let message = this.transcript.get(messageId)
    if (!message) {
      message = { id: messageId, role: 'assistant', blocks: [], createdAt: Date.now() }
      this.transcript.set(messageId, message)
      this.send({ type: 'message_upsert', sessionId, message })
    }
    return message
  }

  private ensureTextBlock(sessionId: string, message: UiMessage) {
    const blockId = this.currentTextBlockId ?? `${message.id}:text:0`
    this.currentTextBlockId = blockId
    return this.ensureTextLikeBlock(sessionId, message, blockId, 'text')
  }

  private ensureThinkingBlock(sessionId: string, message: UiMessage) {
    const blockId = this.currentThinkingBlockId ?? `${message.id}:thinking:0`
    this.currentThinkingBlockId = blockId
    return this.ensureTextLikeBlock(sessionId, message, blockId, 'thinking')
  }

  private ensureTextLikeBlock(sessionId: string, message: UiMessage, blockId: string, type: 'text' | 'thinking') {
    const existing = message.blocks.find((block): block is Extract<UiBlock, { type: typeof type }> => block.id === blockId && block.type === type)
    if (existing) return existing

    const block: UiBlock = type === 'text'
      ? { id: blockId, type: 'text', text: '' }
      : { id: blockId, type: 'thinking', text: '', collapsed: true }
    this.upsertBlock(message, block)
    this.send({ type: 'message_block_upsert', sessionId, messageId: message.id, block })
    return block
  }

  private ensureToolBlockLocation(sessionId: string, toolCallId: string): ToolBlockLocation {
    const existing = this.toolBlocks.get(toolCallId)
    if (existing) return existing
    const message = this.ensureAssistantMessage(sessionId)
    const location = {
      messageId: message.id,
      callBlockId: `${message.id}:tool:${toolCallId}:call`,
      resultBlockId: `${message.id}:tool:${toolCallId}:result`,
    }
    this.toolBlocks.set(toolCallId, location)
    return location
  }

  private toolCallId(event: any, phase: 'start' | 'update' | 'end') {
    const explicit = extractToolCallId(event)
    if (explicit) return explicit
    if (phase === 'start' || !this.anonymousToolCallId) {
      this.anonymousToolCallId = `anonymous-${++this.anonymousToolCallCounter}`
    }
    return this.anonymousToolCallId
  }

  private upsertBlock(message: UiMessage, block: UiBlock) {
    const index = message.blocks.findIndex((item) => item.id === block.id || areSameToolBlock(item, block))
    if (index === -1) {
      message.blocks.push(block)
    } else {
      message.blocks[index] = block
    }
  }

  private flushCurrentAssistantMessage(sessionId: string) {
    const message = this.transcript.get(this.currentAssistantMessageId)
    if (message) {
      this.send({ type: 'message_upsert', sessionId, message })
    }
  }

  private sendStatus(send: SendEvent = this.send) {
    const session = this.session
    if (!session) return
    send({ type: 'status', sessionId: session.sessionId, isStreaming: session.isStreaming, pendingMessageCount: session.pendingMessageCount, pendingApprovalCount: this.uiContext?.pendingCount ?? 0 })
  }

  private isWorkflowBusy() {
    const session = this.session
    return Boolean(session?.isStreaming || (session?.pendingMessageCount ?? 0) > 0)
  }

  private requireSession(required?: true): NonNullable<PiSessionController['session']>
  private requireSession(required: false): PiSessionController['session']
  private requireSession(required = true) {
    const session = this.session
    if (!session && required) throw new Error('Pi session is not initialized')
    return session
  }

  private requireSessionManager() {
    if (!this.sessionManager) throw new Error('Pi session manager is not initialized')
    return this.sessionManager
  }
}

/** Converts Pi SDK message content into normalized UiBlock entries. */
export function normalizeMessages(messages: any[]): UiMessage[] {
  const normalized: UiMessage[] = []
  let lastAssistant: UiMessage | undefined

  messages.forEach((message, index) => {
    if (isToolResultMessage(message)) {
      const target = lastAssistant ?? createSyntheticAssistantMessage(message, index)
      appendToolResultToMessage(target, message, index)
      if (!lastAssistant) {
        normalized.push(target)
        lastAssistant = target
      }
      return
    }

    const messageId = message.id ?? `history-${index}`
    const uiMessage = {
      id: messageId,
      role: normalizeRole(message.role),
      blocks: normalizeContent(message.content ?? message, messageId),
      createdAt: message.createdAt ?? message.timestamp,
    }
    normalized.push(uiMessage)
    lastAssistant = uiMessage.role === 'assistant' ? uiMessage : lastAssistant
  })

  return normalized
}

function isToolResultMessage(message: any) {
  return message?.role === 'toolResult' || message?.role === 'tool'
}

function createSyntheticAssistantMessage(message: any, index: number): UiMessage {
  const messageId = `history-tool-host-${message.id ?? index}`
  return {
    id: messageId,
    role: 'assistant',
    blocks: [],
    createdAt: message.createdAt ?? message.timestamp,
  }
}

function appendToolResultToMessage(message: UiMessage, toolResult: any, index: number) {
  const toolCallId = extractToolCallId(toolResult) ?? `tool-${index}`
  const toolName = toolResult.toolName ?? toolResult.name ?? toolResult.tool ?? 'tool'
  const callBlockId = `${message.id}:tool:${toolCallId}:call`
  const resultBlockId = `${message.id}:tool:${toolCallId}:result`
  const existingCall = findToolCallBlock(message, toolCallId)

  if (existingCall) {
    existingCall.id = callBlockId
    existingCall.toolName = existingCall.toolName || toolName
    existingCall.input ??= extractToolInput(toolResult)
    existingCall.status = toolResult.isError ? 'error' : 'completed'
  } else {
    message.blocks.push({
      id: callBlockId,
      type: 'tool_call',
      toolCallId,
      toolName,
      input: extractToolInput(toolResult),
      status: toolResult.isError ? 'error' : 'completed',
    })
  }

  const resultBlock: UiBlock = {
    id: resultBlockId,
    type: 'tool_result',
    toolCallId,
    content: normalizeToolResultContent(toolResult),
    isError: toolResult.isError ?? Boolean(toolResult.error),
  }
  const existingIndex = message.blocks.findIndex((block) => block.id === resultBlockId)
  if (existingIndex === -1) {
    message.blocks.push(resultBlock)
  } else {
    message.blocks[existingIndex] = resultBlock
  }
}

function normalizeToolResultContent(toolResult: any) {
  const content = toolResult.content ?? toolResult.result ?? toolResult.output ?? toolResult.error ?? toolResult
  return flattenText(content)
}

function normalizeRole(role: unknown): UiMessage['role'] {
  if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') return role
  if (role === 'toolResult') return 'tool'
  return 'system'
}

/**
 * Converts Pi SDK message content into normalized UiBlock entries.
 *
 * Handles string content, arrays of structured content parts (text, thinking, tool_call,
 * tool_result), and falls back to JSON serialization for unknown shapes.
 */
function normalizeContent(content: unknown, messageId: string): UiBlock[] {
  if (typeof content === 'string') {
    return [{ id: `${messageId}:text:0`, type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    const blocks = content.map((part, index) => normalizeContentPart(part, messageId, index)).filter(Boolean) as UiBlock[]
    if (blocks.length === 0) {
      return [{ id: `${messageId}:text:0`, type: 'text', text: '' }]
    }
    return blocks
  }
  return [{ id: `${messageId}:text:0`, type: 'text', text: flattenText(content) }]
}

function normalizeContentPart(part: any, messageId: string, index: number): UiBlock | null {
  if (typeof part === 'string') {
    return { id: `${messageId}:text:${index}`, type: 'text', text: part }
  }

  const type = part?.type

  if (type === 'text') {
    return { id: part.id ?? `${messageId}:text:${index}`, type: 'text', text: part.text ?? '' }
  }

  if (type === 'thinking') {
    return { id: part.id ?? `${messageId}:thinking:${index}`, type: 'thinking', text: part.thinking ?? part.text ?? '', collapsed: part.collapsed ?? true }
  }

  if (type === 'tool_call' || type === 'toolCall') {
    const toolCallId = extractToolCallId(part) ?? `tool-${index}`
    return {
      id: `${messageId}:tool:${toolCallId}:call`,
      type: 'tool_call',
      toolCallId,
      toolName: part.toolName ?? part.name ?? part.tool ?? '',
      input: extractToolInput(part),
      status: part.status ?? 'completed',
    }
  }

  if (type === 'tool_result' || type === 'toolResult') {
    const toolCallId = extractToolCallId(part) ?? `tool-${index}`
    return {
      id: `${messageId}:tool:${toolCallId}:result`,
      type: 'tool_result',
      toolCallId,
      content: typeof part.content === 'string' ? part.content : flattenText(part.content),
      isError: part.isError ?? false,
    }
  }

  if (part?.text) {
    return { id: part.id ?? `${messageId}:text:${index}`, type: 'text', text: part.text }
  }

  return null
}

export function extractToolCallId(value: any): string | undefined {
  const id = value?.toolCallId
    ?? value?.tool_call_id
    ?? value?.callID
    ?? value?.callId
    ?? value?.toolUseId
    ?? value?.tool_use_id
    ?? value?.toolCall?.id
    ?? value?.toolCall?.toolCallId
    ?? value?.call?.id
    ?? value?.execution?.toolCallId
    ?? value?.execution?.id
    ?? value?.id
  return id === undefined || id === null || id === '' ? undefined : String(id)
}

export function extractToolInput(value: any): unknown {
  return value?.input ?? value?.args ?? value?.params ?? value?.arguments ?? value?.toolInput ?? value?.toolCall?.arguments
}

export function findToolCallBlock(message: UiMessage, toolCallId: string) {
  return message.blocks.find((block): block is Extract<UiBlock, { type: 'tool_call' }> => block.type === 'tool_call' && block.toolCallId === toolCallId)
}

export function areSameToolBlock(left: UiBlock, right: UiBlock) {
  if (left.type === 'tool_call' && right.type === 'tool_call') return left.toolCallId === right.toolCallId
  if (left.type === 'tool_result' && right.type === 'tool_result') return left.toolCallId === right.toolCallId
  return false
}

export function flattenText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'string' ? part : part?.text ?? '').join('')
  }
  return JSON.stringify(content)
}

export function toPiImages(images?: ImagePayload[]): any[] | undefined {
  return images?.map((image) => ({
    type: 'image',
    source: {
      type: 'base64',
      mediaType: image.mediaType,
      data: image.data,
    },
  }))
}

export function toUiSessionSummary(info: any): UiSessionSummary {
  return {
    file: info.path ?? info.file ?? info.sessionFile,
    name: info.name,
    createdAt: toTimestamp(info.created ?? info.createdAt),
    updatedAt: toTimestamp(info.modified ?? info.updatedAt ?? info.mtimeMs),
    firstMessage: info.firstMessage ?? info.preview,
  }
}

export function toUiModel(model: any): UiModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    availableThinkingLevels: supportedThinkingLevels(model),
  }
}

export function normalizeThinkingLevel(level: unknown): ThinkingLevel {
  return DEFAULT_THINKING_LEVELS.includes(level as ThinkingLevel) ? level as ThinkingLevel : 'off'
}

export function supportedThinkingLevels(model: any): ThinkingLevel[] {
  if (!model?.reasoning) return ['off']
  return DEFAULT_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh') return mapped !== undefined
    return true
  })
}

export function summarizeSessionManager(sessionManager: SessionManager): Omit<UiSessionSummary, 'file'> {
  const header = sessionManager.getHeader()
  const entries = sessionManager.getEntries()
  const latestEntry = entries.at(-1)
  return {
    name: sessionManager.getSessionName(),
    createdAt: toTimestamp(header?.timestamp),
    updatedAt: toTimestamp(latestEntry?.timestamp ?? header?.timestamp),
    firstMessage: firstUserMessage(entries),
  }
}

export function firstUserMessage(entries: any[]) {
  for (const entry of entries) {
    const message = entry?.type === 'message' ? entry.message : undefined
    if (message?.role !== 'user') continue
    const text = flattenText(message.content)
    if (text) return text
  }
  return undefined
}

export function toTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const timestamp = Date.parse(value)
    return Number.isNaN(timestamp) ? undefined : timestamp
  }
  return undefined
}

export function summarizeToolResult(result: unknown) {
  const text = flattenText(result)
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
}
