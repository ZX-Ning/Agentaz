import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type CreateAgentSessionResult,
} from '@earendil-works/pi-coding-agent'
import type { ClientCommand, ImagePayload, ServerEvent, ThinkingLevel, UiMessage, UiModel, UiSessionSummary } from '../../types/protocol'
import { PROTOCOL_VERSION } from '../../types/protocol'
import { WebExtensionUIContext } from './extension-ui-context'
import { ensurePermissionConfig } from './permission-config'

/** Emits a normalized server event to the connected browser client. */
type SendEvent = (event: ServerEvent) => void

/** Model and thinking-level changes requested while the agent is still busy. */
type PendingSettings = {
  model?: any
  thinkingLevel?: ThinkingLevel
}

/**
 * Coordinates a Pi SDK agent session for the WebSocket backend.
 *
 * The service owns Pi session creation, session switching, command dispatch, permission UI wiring,
 * model/thinking changes, and translation of Pi runtime events into the normalized web protocol.
 * It is scoped to one active browser connection and should be disposed when that connection closes.
 */
export class PiAgentService {
  private authStorage = AuthStorage.create()
  private modelRegistry = ModelRegistry.create(this.authStorage)
  private sessionResult?: CreateAgentSessionResult
  private unsubscribe?: () => void
  private uiContext?: WebExtensionUIContext
  private pendingSettings: PendingSettings = {}
  private initializing?: Promise<void>

  constructor(
    private readonly cwd: string,
    private readonly send: SendEvent,
    private readonly approvalTimeoutMs: number,
  ) {}

  /** Returns the active Pi SDK session, if initialization has completed. */
  get session() {
    return this.sessionResult?.session
  }

  /** Lazily initializes a fresh session once for the current service instance. */
  async initNewSession() {
    if (!this.initializing) {
      this.initializing = this.createNewSession()
    }
    await this.initializing
  }

  /** Creates and broadcasts a new persisted session for the configured working directory. */
  async createNewSession() {
    await this.replaceSession(SessionManager.create(this.cwd), true)
  }

  /** Opens an existing session file, aborting the current workflow only when explicitly allowed. */
  async openSession(sessionFile: string, abortCurrent = false) {
    await this.ensureSafeToSwitch(abortCurrent)
    await this.replaceSession(SessionManager.open(sessionFile, undefined, this.cwd), false)
  }

  /** Lists persisted sessions for the configured working directory and sends them to the browser. */
  async listSessions() {
    const sessions = await SessionManager.list(this.cwd)
    this.send({
      type: 'session_list_result',
      sessions: sessions.map(toUiSessionSummary),
    })
  }

  /** Dispatches a typed browser command to the appropriate Pi SDK operation or UI response handler. */
  async handleCommand(command: ClientCommand) {
    await this.initNewSession()

    switch (command.type) {
      case 'prompt':
        await this.requireSession().prompt(command.text, { images: toPiImages(command.images) })
        break
      case 'steer':
        await this.requireSession().prompt(command.text, { images: toPiImages(command.images), streamingBehavior: 'steer' })
        break
      case 'follow_up':
        await this.requireSession().prompt(command.text, { images: toPiImages(command.images), streamingBehavior: 'followUp' })
        break
      case 'abort':
        this.uiContext?.cancelAll()
        await this.requireSession().abort()
        this.sendStatus()
        break
      case 'clear_queue': {
        const cleared = this.requireSession().clearQueue()
        this.send({ type: 'queue_update', steering: [], followUp: [] })
        console.log('[pi-web] cleared queue', cleared)
        break
      }
      case 'session_new':
        await this.ensureSafeToSwitch(true)
        await this.createNewSession()
        break
      case 'session_list':
        await this.listSessions()
        break
      case 'session_open':
        await this.openSession(command.sessionFile, command.abortCurrent)
        break
      case 'model_list':
        this.sendModelList()
        break
      case 'model_set':
        await this.setModel(command.provider, command.id)
        break
      case 'thinking_set':
        this.setThinkingLevel(command.level)
        break
      case 'ui_select_response':
        this.uiContext?.resolveSelect(command.requestId, command.selected)
        break
      case 'ui_input_response':
        this.uiContext?.resolveInput(command.requestId, command.value)
        break
      case 'ui_confirm_response':
        this.uiContext?.resolveConfirm(command.requestId, command.confirmed)
        break
      default:
        assertNever(command)
    }
  }

  /** Releases extension prompts, subscriptions, and the active Pi session. */
  async dispose() {
    this.uiContext?.cancelAll()
    this.unsubscribe?.()
    this.requireSession(false)?.dispose()
  }

  /** Cancels outstanding permission or extension UI prompts without disposing the whole service. */
  cancelPendingApprovals() {
    this.uiContext?.cancelAll()
  }

  /** Sends the protocol handshake and capability declaration for the active session. */
  sendHello() {
    const session = this.session
    this.send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      cwd: this.cwd,
      sessionId: session?.sessionId ?? '',
      sessionFile: session?.sessionFile,
      capabilities: {
        steer: true,
        followUp: true,
        clearQueue: true,
        permissions: true,
        modelSelect: true,
        thinkingSelect: true,
        images: false,
        fileTree: false,
        diffViewer: false,
      },
    })
  }

  private async replaceSession(sessionManager: SessionManager, forceNew: boolean) {
    // Tear down browser prompts and Pi subscriptions before swapping the underlying SDK session.
    this.uiContext?.cancelAll()
    this.unsubscribe?.()
    this.session?.dispose()

    // Ensure the project has a permission-system config before extensions load for the session.
    await ensurePermissionConfig(this.cwd)

    if (forceNew) {
      sessionManager.newSession()
    }

    this.sessionResult = await createAgentSession({
      cwd: this.cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager,
    })

    const session = this.requireSession()

    // Bind extensions to the WebSocket-backed UI context so permission prompts reach the browser.
    this.uiContext = new WebExtensionUIContext(this.send, this.approvalTimeoutMs)
    await session.bindExtensions({
      uiContext: this.uiContext as any,
      onError: (error) => {
        console.error('[pi-web] extension error', error)
        this.sendError('extension_error', error instanceof Error ? error.message : String(error), true)
      },
    })

    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event as any))

    // Broadcast enough state for a browser client to render immediately after connecting or switching.
    this.sendHello()
    this.send({ type: 'history', messages: normalizeMessages(session.messages as any[]) })
    this.send({ type: 'session_changed', sessionId: session.sessionId, sessionFile: session.sessionFile, history: normalizeMessages(session.messages as any[]) })
    this.sendModelList()
    this.sendStatus()
  }

  private async ensureSafeToSwitch(abortCurrent?: boolean) {
    const session = this.session
    if (!session) return
    if (session.isStreaming && !abortCurrent) {
      throw new Error('Agent is running; pass abortCurrent to switch sessions.')
    }
    if (session.isStreaming) {
      this.uiContext?.cancelAll()
      await session.abort()
    }
  }

  private async setModel(provider: string, id: string) {
    const model = this.modelRegistry.find(provider, id)
    if (!model) throw new Error(`Unknown model: ${provider}/${id}`)

    const session = this.requireSession()
    if (this.isWorkflowBusy()) {
      this.pendingSettings.model = model
      this.send({ type: 'model_changed', model: toUiModel(model), pending: true })
      return
    }

    await session.setModel(model)
    this.send({
      type: 'model_changed',
      model: toUiModel(model),
      pending: false,
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels(),
    })
  }

  private setThinkingLevel(level: ThinkingLevel) {
    const session = this.requireSession()
    if (this.isWorkflowBusy()) {
      this.pendingSettings.thinkingLevel = level
      this.send({ type: 'thinking_changed', level, pending: true })
      return
    }

    session.setThinkingLevel(level)
    this.send({ type: 'thinking_changed', level: session.thinkingLevel, pending: false })
  }

  private async applyPendingSettingsIfIdle() {
    const session = this.session
    if (!session || this.isWorkflowBusy()) return

    const { model, thinkingLevel } = this.pendingSettings
    this.pendingSettings = {}

    if (model) {
      await session.setModel(model)
      this.send({
        type: 'model_changed',
        model: toUiModel(model),
        pending: false,
        thinkingLevel: session.thinkingLevel,
        availableThinkingLevels: session.getAvailableThinkingLevels(),
      })
    }
    if (thinkingLevel) {
      session.setThinkingLevel(thinkingLevel)
      this.send({ type: 'thinking_changed', level: session.thinkingLevel, pending: false })
    }
  }

  private onSessionEvent(event: any) {
    try {
      switch (event.type) {
        case 'message_update':
          this.forwardMessageUpdate(event)
          break
        case 'tool_execution_start':
        case 'tool_start':
          this.send({ type: 'tool_start', toolCallId: event.toolCallId ?? event.id ?? crypto.randomUUID(), toolName: event.toolName ?? event.name ?? 'tool', input: event.input ?? event.params })
          break
        case 'tool_execution_update':
        case 'tool_update':
          this.send({ type: 'tool_update', toolCallId: event.toolCallId ?? event.id ?? '', partial: event })
          break
        case 'tool_execution_end':
        case 'tool_end':
          this.send({ type: 'tool_end', toolCallId: event.toolCallId ?? event.id ?? '', isError: Boolean(event.isError ?? event.error), summary: summarizeToolResult(event.result ?? event.output ?? event.error) })
          break
        case 'queue_update':
          this.send({ type: 'queue_update', steering: [...event.steering], followUp: [...event.followUp] })
          void this.applyPendingSettingsIfIdle()
          break
        case 'agent_end':
          this.sendStatus()
          void this.applyPendingSettingsIfIdle()
          break
        case 'thinking_level_changed':
          this.send({ type: 'thinking_changed', level: event.level, pending: false })
          break
      }
    } catch (error) {
      console.error('[pi-web] failed to forward session event', error)
    }
  }

  private forwardMessageUpdate(event: any) {
    const messageEvent = event.assistantMessageEvent ?? event.messageEvent ?? event
    if (messageEvent.type === 'text_delta') {
      this.send({ type: 'message_delta', messageId: event.messageId ?? 'assistant-current', blockType: 'text', delta: messageEvent.delta ?? '' })
    }
    if (messageEvent.type === 'thinking_delta') {
      this.send({ type: 'message_delta', messageId: event.messageId ?? 'assistant-current', blockType: 'thinking', delta: messageEvent.delta ?? '' })
    }
  }

  private sendModelList() {
    const session = this.session
    this.send({
      type: 'model_list_result',
      models: this.modelRegistry.getAvailable().map(toUiModel),
      current: session?.model ? toUiModel(session.model) : undefined,
      thinkingLevel: session?.thinkingLevel,
      availableThinkingLevels: session?.getAvailableThinkingLevels(),
    })
  }

  private sendStatus() {
    const session = this.session
    if (!session) return
    this.send({ type: 'status', isStreaming: session.isStreaming, pendingMessageCount: session.pendingMessageCount })
  }

  private isWorkflowBusy() {
    const session = this.session
    return Boolean(session?.isStreaming || (session?.pendingMessageCount ?? 0) > 0)
  }

  private sendError(code: string, message: string, recoverable: boolean) {
    this.send({ type: 'error', code, message, recoverable })
  }

  private requireSession(required?: true): NonNullable<PiAgentService['session']>
  private requireSession(required: false): PiAgentService['session']
  private requireSession(required = true) {
    const session = this.session
    if (!session && required) throw new Error('Pi session is not initialized')
    return session
  }
}

function normalizeMessages(messages: any[]): UiMessage[] {
  return messages.map((message, index) => ({
    id: message.id ?? `history-${index}`,
    role: normalizeRole(message.role),
    blocks: [{ type: 'text', text: extractText(message.content ?? message) }],
    createdAt: message.createdAt ?? message.timestamp,
  }))
}

function normalizeRole(role: unknown): UiMessage['role'] {
  return role === 'user' || role === 'assistant' || role === 'tool' || role === 'system' ? role : 'system'
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'string' ? part : part?.text ?? '').join('')
  }
  return JSON.stringify(content)
}

function toPiImages(images?: ImagePayload[]): any[] | undefined {
  return images?.map((image) => ({
    type: 'image',
    source: {
      type: 'base64',
      mediaType: image.mediaType,
      data: image.data,
    },
  }))
}

function toUiSessionSummary(info: any): UiSessionSummary {
  return {
    file: info.file ?? info.path ?? info.sessionFile,
    name: info.name,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt ?? info.mtimeMs,
    firstMessage: info.firstMessage ?? info.preview,
  }
}

function toUiModel(model: any): UiModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
  }
}

function summarizeToolResult(result: unknown) {
  const text = typeof result === 'string' ? result : JSON.stringify(result)
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

function assertNever(value: never): never {
  throw new Error(`Unhandled command: ${JSON.stringify(value)}`)
}
