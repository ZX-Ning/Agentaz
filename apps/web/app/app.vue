<script setup lang="ts">
import type {
  AgentStateResponse,
  MessageSubmitRequest,
  ModelSetRequest,
  ModelStateResponse,
  ServerEvent,
  ServerHello,
  SessionHistoryResponse,
  SessionOperationResponse,
  ThinkingLevel,
  UiLoadedSession,
  UiMessage,
  UiModel,
  UiRequestResponseRequest,
  UiSessionSummary,
  UiBlock,
} from '../types/protocol'

type SessionModelState = {
  models: UiModel[]
  currentModel: UiModel | null
  thinkingLevel: ThinkingLevel
  availableThinkingLevels: ThinkingLevel[]
  pendingModelChange: boolean
  pendingThinkingChange: boolean
}

type PendingUiRequest =
  | Extract<ServerEvent, { type: 'ui_select_request' }>
  | Extract<ServerEvent, { type: 'ui_input_request' }>
  | Extract<ServerEvent, { type: 'ui_confirm_request' }>

type SessionListItem = {
  id: string
  file: string | null
  sessionId: string | null
  isDraft: boolean
  isLoaded: boolean
  isActive: boolean
  isStreaming: boolean
  pendingApprovalCount: number
  title: string
  updatedAt?: number
}

const DRAFT_SESSION_PREFIX = 'draft-session-'
const toast = useToast()
const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

const status = ref<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting')
const hello = ref<ServerHello | null>(null)
const clientId = ref('')
const activeSessionId = ref<string | null>(null)
const loadedSessions = ref<UiLoadedSession[]>([])
const persistedSessions = ref<UiSessionSummary[]>([])
const messagesBySessionId = ref<Record<string, UiMessage[]>>({})
const modelStateBySessionId = ref<Record<string, SessionModelState>>({})
const pendingUiRequestsBySessionId = ref<Record<string, PendingUiRequest[]>>({})
const promptText = ref('')
const lastError = ref<string | null>(null)
const socket = shallowRef<WebSocket | null>(null)

const isSidebarOpen = ref(false)
const isStatusMenuOpen = ref(false)

function onStatusMenuOpenChange(open: boolean) {
  isStatusMenuOpen.value = open
}

function formatTime(timestamp?: number) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const thinkingOptions: Array<{ value: ThinkingLevel, label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
]

const activeLoadedSession = computed(() => loadedSessions.value.find((session) => session.sessionId === activeSessionId.value) ?? null)
const isActiveDraftSession = computed(() => isDraftSessionId(activeSessionId.value))
const activeMessages = computed(() => activeSessionId.value ? messagesBySessionId.value[activeSessionId.value] ?? [] : [])
const activeModelState = computed(() => activeSessionId.value ? ensureModelState(activeSessionId.value) : defaultModelState())
const activePendingUiRequests = computed(() => activeSessionId.value ? pendingUiRequestsBySessionId.value[activeSessionId.value] ?? [] : [])
const unifiedSessions = computed(() => {
  const list: SessionListItem[] = []
  const loadedByFile = new Map<string, UiLoadedSession>()

  if (isActiveDraftSession.value && activeSessionId.value) {
    list.push({
      id: activeSessionId.value,
      file: null,
      sessionId: activeSessionId.value,
      isDraft: true,
      isLoaded: false,
      isActive: true,
      isStreaming: false,
      pendingApprovalCount: 0,
      title: 'New session',
      updatedAt: Date.now(),
    })
  }

  for (const session of loadedSessions.value) {
    const file = session.sessionFile ?? session.file
    if (file) loadedByFile.set(file, session)
  }

  for (const persisted of persistedSessions.value) {
    const loaded = findLoadedSessionByFile(persisted.file, loadedByFile)
    list.push(toSessionListItem(loaded ?? persisted, loaded, persisted))
  }

  for (const loaded of loadedSessions.value) {
    const file = loaded.sessionFile ?? loaded.file
    if (file && persistedSessions.value.some((session) => session.file === file)) continue
    list.push(toSessionListItem(loaded, loaded))
  }

  return list.sort((left, right) => Number(right.isActive) - Number(left.isActive) || Number(right.isStreaming) - Number(left.isStreaming) || (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
})

async function handleSessionClick(session: SessionListItem) {
  if (session.isDraft && session.sessionId) {
    activeSessionId.value = session.sessionId
    isSidebarOpen.value = false
    return
  }
  if (session.isLoaded && session.sessionId) {
    await focusSessionAndClose(session.sessionId)
  } else if (session.file) {
    const loaded = findLoadedSessionByFile(session.file)
    if (loaded) {
      await focusSessionAndClose(loaded.sessionId)
      return
    }
    await openPersistedSessionAndClose(session.file)
  }
}
const models = computed(() => activeModelState.value.models)
const currentModel = computed(() => activeModelState.value.currentModel)
const currentThinkingLevel = computed(() => activeModelState.value.thinkingLevel)
const availableThinkingLevels = computed(() => activeModelState.value.availableThinkingLevels)
const pendingModelChange = computed(() => activeModelState.value.pendingModelChange)
const pendingThinkingChange = computed(() => activeModelState.value.pendingThinkingChange)
const isStreaming = computed(() => Boolean(activeLoadedSession.value?.isStreaming))
const pendingMessageCount = computed(() => activeLoadedSession.value?.pendingMessageCount ?? 0)
const pendingApprovalCount = computed(() => activeLoadedSession.value?.pendingApprovalCount ?? activePendingUiRequests.value.length)
const canControlActiveSession = computed(() => Boolean(activeLoadedSession.value))
const canSubmitToActiveSession = computed(() => Boolean(activeSessionId.value))
const hasMessages = computed(() => activeMessages.value.length > 0)
const selectedModelKey = computed(() => currentModel.value ? modelKey(currentModel.value) : '')
const visibleThinkingOptions = computed(() => {
  const levels = availableThinkingLevels.value.length > 0 ? availableThinkingLevels.value : ['off']
  return thinkingOptions.filter((option) => levels.includes(option.value))
})
const modelOptions = computed(() => models.value.map((model) => ({
  value: modelKey(model),
  label: `${model.name || model.id} - ${model.provider}`,
  description: `${model.provider}/${model.id}`,
  model,
})))
const statusColor = computed(() => {
  if (status.value === 'connected') return 'success'
  if (status.value === 'connecting') return 'warning'
  if (status.value === 'error') return 'error'
  return 'neutral'
})
const statusLabel = computed(() => {
  if (status.value === 'connected') return isStreaming.value ? 'Streaming' : 'Connected'
  if (status.value === 'connecting') return 'Connecting'
  if (status.value === 'error') return 'Error'
  return 'Disconnected'
})

function defaultModelState(): SessionModelState {
  return {
    models: [],
    currentModel: null,
    thinkingLevel: 'off',
    availableThinkingLevels: ['off'],
    pendingModelChange: false,
    pendingThinkingChange: false,
  }
}

const collapsedStates = ref<Record<string, boolean>>({})

function getBlockKey(messageId: string, block: UiBlock, index: number): string {
  return block.id || `${messageId}-${index}`
}

function isBlockCollapsed(key: string, defaultState = true) {
  if (collapsedStates.value[key] === undefined) {
    collapsedStates.value[key] = defaultState
  }
  return collapsedStates.value[key]
}

function toggleBlock(key: string) {
  collapsedStates.value[key] = !collapsedStates.value[key]
}

function ensureModelState(sessionId: string) {
  modelStateBySessionId.value[sessionId] ??= defaultModelState()
  return modelStateBySessionId.value[sessionId]
}

function ensureMessageBucket(sessionId: string) {
  messagesBySessionId.value[sessionId] ??= []
  return messagesBySessionId.value[sessionId]
}

function isDraftSessionId(sessionId?: string | null) {
  return Boolean(sessionId?.startsWith(DRAFT_SESSION_PREFIX))
}

function createDraftSessionId() {
  return `${DRAFT_SESSION_PREFIX}${Date.now()}`
}

function createDraftSession() {
  const previousModelState = activeSessionId.value ? modelStateBySessionId.value[activeSessionId.value] : undefined
  const sessionId = createDraftSessionId()
  activeSessionId.value = sessionId
  ensureMessageBucket(sessionId)
  modelStateBySessionId.value[sessionId] = previousModelState
    ? {
        models: previousModelState.models,
        currentModel: previousModelState.currentModel,
        thinkingLevel: previousModelState.thinkingLevel,
        availableThinkingLevels: previousModelState.availableThinkingLevels,
        pendingModelChange: false,
        pendingThinkingChange: false,
      }
    : defaultModelState()
  return sessionId
}

function ensureDraftSession() {
  if (!activeSessionId.value) return createDraftSession()
  return activeSessionId.value
}

async function materializeDraftSession(draftSessionId: string) {
  const draftModelState = modelStateBySessionId.value[draftSessionId]
  const state = await agentFetch<SessionOperationResponse>('/api/agent/sessions', { method: 'POST' })
  const sessionId = state.sessionId ?? state.activeSessionId
  if (!sessionId) throw new Error('Backend did not return a created session id.')

  messagesBySessionId.value[sessionId] = messagesBySessionId.value[draftSessionId] ?? []
  delete messagesBySessionId.value[draftSessionId]
  modelStateBySessionId.value[sessionId] = modelStateBySessionId.value[draftSessionId] ?? defaultModelState()
  delete modelStateBySessionId.value[draftSessionId]
  activeSessionId.value = sessionId
  applyState(state)
  activeSessionId.value = sessionId
  if (draftModelState?.currentModel) {
    const body: ModelSetRequest = { provider: draftModelState.currentModel.provider, id: draftModelState.currentModel.id }
    applyModelState(await agentFetch<ModelStateResponse>(sessionUrl(sessionId, '/model'), { method: 'PUT', body }))
  }
  if (draftModelState?.thinkingLevel) {
    applyModelState(await agentFetch<ModelStateResponse>(sessionUrl(sessionId, '/thinking'), { method: 'PUT', body: { level: draftModelState.thinkingLevel } }))
  }
  return sessionId
}

function modelKey(model: UiModel) {
  return JSON.stringify([model.provider, model.id])
}

function sessionUrl(sessionId: string, suffix = '') {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}${suffix}`
}

function roleLabel(role: UiMessage['role']) {
  if (role === 'assistant') return 'ai'
  if (role === 'user') return 'You'
  return role
}

function sessionTitle(session: UiLoadedSession | UiSessionSummary) {
  return session.firstMessage || session.name || ('sessionId' in session ? session.sessionId.slice(0, 8) : 'Untitled session')
}

function findLoadedSessionByFile(file: string, indexedByFile?: Map<string, UiLoadedSession>) {
  const indexed = indexedByFile?.get(file)
  if (indexed) return indexed
  return loadedSessions.value.find((session) => session.sessionFile === file || session.file === file || session.sessionId === file)
}

function toSessionListItem(source: UiLoadedSession | UiSessionSummary, loaded?: UiLoadedSession, persisted?: UiSessionSummary): SessionListItem {
  const sessionFile = loaded?.sessionFile ?? loaded?.file ?? persisted?.file ?? ('file' in source ? source.file : null)
  const sessionId = loaded?.sessionId ?? null
  return {
    id: sessionId ?? sessionFile ?? sessionTitle(source),
    file: sessionFile,
    sessionId,
    isDraft: false,
    isLoaded: Boolean(loaded),
    isActive: Boolean(sessionId && sessionId === activeSessionId.value),
    isStreaming: loaded?.isStreaming ?? false,
    pendingApprovalCount: loaded?.pendingApprovalCount ?? 0,
    title: loaded ? sessionTitle({ ...persisted, ...loaded }) : sessionTitle(source),
    updatedAt: persisted?.updatedAt ?? persisted?.createdAt ?? ('updatedAt' in source ? source.updatedAt : undefined) ?? ('createdAt' in source ? source.createdAt : undefined),
  }
}

async function agentFetch<T>(url: string, options?: Parameters<typeof $fetch<T>>[1]) {
  try {
    return await $fetch<T>(url, options)
  } catch (error) {
    const data = (error as any)?.data?.data ?? (error as any)?.data
    const message = data?.message ?? (error instanceof Error ? error.message : String(error))
    lastError.value = message
    toast.add({ title: data?.code ?? 'agent_http_error', description: message, color: 'error' })
    throw error
  }
}

function applyState(state: AgentStateResponse | SessionOperationResponse) {
  activeSessionId.value = state.activeSessionId ?? (isDraftSessionId(activeSessionId.value) ? activeSessionId.value : null)
  loadedSessions.value = state.loadedSessions
  persistedSessions.value = state.persistedSessions
}

function applyModelState(state: ModelStateResponse) {
  const modelState = ensureModelState(state.sessionId)
  modelState.models = state.models
  modelState.currentModel = state.pendingModel ?? state.current ?? null
  modelState.pendingModelChange = Boolean(state.pendingModel)
  modelState.pendingThinkingChange = Boolean(state.pendingThinkingLevel)
  updateThinkingState(state.sessionId, state.pendingThinkingLevel ?? state.thinkingLevel, state.availableThinkingLevels)
}

async function refreshState() {
  const state = await agentFetch<AgentStateResponse>('/api/agent/state')
  applyState(state)
  if (state.activeSessionId) {
    await refreshSessionDetails(state.activeSessionId)
  } else {
    await refreshDraftModelState(ensureDraftSession())
  }
}

async function refreshSessionDetails(sessionId: string) {
  if (isDraftSessionId(sessionId)) return
  await Promise.all([
    refreshHistory(sessionId),
    refreshModelState(sessionId),
  ])
}

async function refreshHistory(sessionId: string) {
  if (isDraftSessionId(sessionId)) return
  if (messagesBySessionId.value[sessionId]?.length) return
  const history = await agentFetch<SessionHistoryResponse>(sessionUrl(sessionId, '/history'))
  messagesBySessionId.value[sessionId] = history.messages
}

async function refreshModelState(sessionId: string) {
  if (isDraftSessionId(sessionId)) return
  applyModelState(await agentFetch<ModelStateResponse>(sessionUrl(sessionId, '/models')))
}

async function refreshDraftModelState(sessionId: string) {
  if (!isDraftSessionId(sessionId) || modelStateBySessionId.value[sessionId]?.models.length) return
  const state = await agentFetch<ModelStateResponse>('/api/agent/models')
  applyModelState({ ...state, sessionId })
}

async function postSessionOperation(path: string, options?: Parameters<typeof $fetch<SessionOperationResponse>>[1]) {
  const state = await agentFetch<SessionOperationResponse>(path, options)
  applyState(state)
  if (state.activeSessionId) await refreshSessionDetails(state.activeSessionId)
}

async function sendPrompt() {
  let sessionId = activeSessionId.value
  const text = promptText.value.trim()
  if (!sessionId || !text) return

  const localMessageId = `local-${Date.now()}`
  ensureMessageBucket(sessionId).push({
    id: localMessageId,
    role: 'user',
    blocks: [{ id: `${localMessageId}:text`, type: 'text', text }],
    createdAt: Date.now(),
  })

  if (isDraftSessionId(sessionId)) {
    sessionId = await materializeDraftSession(sessionId)
  }

  const body: MessageSubmitRequest = { mode: 'prompt', text }
  await agentFetch(sessionUrl(sessionId, '/messages'), { method: 'POST', body })
  promptText.value = ''
}

async function submitComposer() {
  const sessionId = activeSessionId.value
  if (!sessionId) return
  if (!isDraftSessionId(sessionId) && isStreaming.value) {
    await agentFetch(sessionUrl(sessionId, '/abort'), { method: 'POST' })
    return
  }
  await sendPrompt()
}

function toggleTheme() {
  colorMode.preference = isDark.value ? 'light' : 'dark'
}

function updateThinkingState(sessionId: string, level?: ThinkingLevel, levels?: ThinkingLevel[]) {
  const state = ensureModelState(sessionId)
  if (levels?.length) state.availableThinkingLevels = levels
  if (level) state.thinkingLevel = level
  if (!state.availableThinkingLevels.includes(state.thinkingLevel)) {
    state.thinkingLevel = state.availableThinkingLevels[0] ?? 'off'
  }
}

async function handleModelSelect(value: unknown) {
  const sessionId = activeSessionId.value
  if (!sessionId || typeof value !== 'string') return
  const option = modelOptions.value.find((item) => item.value === value)
  if (!option || modelKey(option.model) === selectedModelKey.value) return
  if (isDraftSessionId(sessionId)) {
    const state = ensureModelState(sessionId)
    state.currentModel = option.model
    state.pendingModelChange = false
    return
  }

  const body: ModelSetRequest = { provider: option.model.provider, id: option.model.id }
  applyModelState(await agentFetch<ModelStateResponse>(sessionUrl(sessionId, '/model'), { method: 'PUT', body }))
}

async function handleThinkingSelect(value: unknown) {
  const sessionId = activeSessionId.value
  if (!sessionId || !isThinkingLevel(value)) return
  if (isDraftSessionId(sessionId)) {
    updateThinkingState(sessionId, value)
    return
  }
  applyModelState(await agentFetch<ModelStateResponse>(sessionUrl(sessionId, '/thinking'), { method: 'PUT', body: { level: value } }))
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return thinkingOptions.some((option) => option.value === value)
}

async function createSession() {
  await refreshDraftModelState(createDraftSession())
}

async function openPersistedSession(sessionFile: string) {
  await postSessionOperation('/api/agent/sessions', { method: 'POST', body: { sessionFile } })
}

async function focusSession(sessionId: string) {
  activeSessionId.value = sessionId
  await postSessionOperation(sessionUrl(sessionId, '/focus'), { method: 'POST' })
}

async function createSessionAndClose() {
  await createSession()
  isSidebarOpen.value = false
}

function loadDummySession() {
  const sessionId = 'dummy-test-session'
  const now = Date.now()

  // Inject fake loaded session
  loadedSessions.value = [
    ...loadedSessions.value.filter((s) => s.sessionId !== sessionId),
    {
      file: sessionId,
      sessionId,
      sessionFile: undefined,
      isStreaming: false,
      pendingMessageCount: 0,
      pendingApprovalCount: 0,
    },
  ]

  // Generate 300 fake messages with realistic content
  const messages: UiMessage[] = []
  for (let i = 0; i < 300; i++) {
    const isUser = i % 2 === 0
    const text = isUser
      ? `This is user message #${i / 2 + 1}. How can I help you test the rendering performance of this chat interface? Let me add some more text to make it realistic. `.repeat(3)
      : `This is assistant response #${Math.floor(i / 2) + 1}. Here is a detailed explanation of how the system works. `.repeat(5)
    messages.push({
      id: `dummy-msg-${i}`,
      role: isUser ? 'user' : 'assistant',
      blocks: [
        { id: `dummy-msg-${i}:text:0`, type: 'text', text },
        ...(isUser ? [] : [
          { id: `dummy-msg-${i}:thinking:0`, type: 'thinking' as const, text: `Thinking process for message ${i}... `.repeat(3), collapsed: true },
        ]),
      ],
      createdAt: now - (300 - i) * 60_000,
    })
  }

  messagesBySessionId.value[sessionId] = messages
  activeSessionId.value = sessionId
  isSidebarOpen.value = false
}

async function openPersistedSessionAndClose(sessionFile: string) {
  await openPersistedSession(sessionFile)
  isSidebarOpen.value = false
}

async function focusSessionAndClose(sessionId: string) {
  await focusSession(sessionId)
  isSidebarOpen.value = false
}

async function acquireSession(sessionId = activeSessionId.value) {
  if (sessionId && !isDraftSessionId(sessionId)) await postSessionOperation(sessionUrl(sessionId, '/control'), { method: 'POST', body: { action: 'acquire' } })
}

async function releaseSession(sessionId = activeSessionId.value) {
  if (sessionId && !isDraftSessionId(sessionId)) await postSessionOperation(sessionUrl(sessionId, '/control'), { method: 'POST', body: { action: 'release' } })
}

async function clearActiveQueue() {
  if (activeSessionId.value && !isDraftSessionId(activeSessionId.value)) await agentFetch(sessionUrl(activeSessionId.value, '/queue/clear'), { method: 'POST' })
}

async function closeActiveSession() {
  if (!activeSessionId.value) return
  if (isDraftSessionId(activeSessionId.value)) {
    delete messagesBySessionId.value[activeSessionId.value]
    delete modelStateBySessionId.value[activeSessionId.value]
    activeSessionId.value = null
    ensureDraftSession()
    return
  }
  await postSessionOperation(`${sessionUrl(activeSessionId.value)}?abortCurrent=1`, { method: 'DELETE' })
}

function upsertLoadedSession(sessionId: string, patch: Partial<UiLoadedSession>) {
  const index = loadedSessions.value.findIndex((session) => session.sessionId === sessionId)
  if (index === -1) {
    loadedSessions.value.push({
      file: patch.file ?? patch.sessionFile ?? sessionId,
      sessionId,
      sessionFile: patch.sessionFile,
      isStreaming: patch.isStreaming ?? false,
      pendingMessageCount: patch.pendingMessageCount ?? 0,
      pendingApprovalCount: patch.pendingApprovalCount ?? 0,
      controlledByClientId: patch.controlledByClientId,
      controlledByThisClient: patch.controlledByThisClient,
    })
    return
  }
  const current = loadedSessions.value[index]
  if (!current) return
  loadedSessions.value[index] = {
    ...current,
    ...patch,
    file: patch.file ?? patch.sessionFile ?? current.file,
  }
}

function upsertMessage(sessionId: string, message: UiMessage) {
  const bucket = ensureMessageBucket(sessionId)
  const index = bucket.findIndex((item) => item.id === message.id)
  if (index === -1) bucket.push(message)
  else bucket[index] = message
}

function ensureTranscriptMessage(sessionId: string, messageId: string) {
  const bucket = ensureMessageBucket(sessionId)
  let message = bucket.find((item) => item.id === messageId)
  if (!message) {
    message = { id: messageId, role: 'assistant', blocks: [], createdAt: Date.now() }
    bucket.push(message)
  }
  return message
}

function upsertMessageBlock(sessionId: string, messageId: string, block: UiBlock) {
  const message = ensureTranscriptMessage(sessionId, messageId)
  const index = message.blocks.findIndex((item) => item.id === block.id || areSameToolBlock(item, block))
  if (index === -1) message.blocks.push(block)
  else message.blocks[index] = block
}

function areSameToolBlock(left: UiBlock, right: UiBlock) {
  if (left.type === 'tool_call' && right.type === 'tool_call') return left.toolCallId === right.toolCallId
  if (left.type === 'tool_result' && right.type === 'tool_result') return left.toolCallId === right.toolCallId
  return false
}

function appendMessageBlockDelta(sessionId: string, messageId: string, blockId: string, blockType: 'text' | 'thinking', delta: string) {
  const message = ensureTranscriptMessage(sessionId, messageId)
  let block = message.blocks.find((item) => item.id === blockId)
  if (!block) {
    block = blockType === 'text'
      ? { id: blockId, type: 'text', text: '' }
      : { id: blockId, type: 'thinking', text: '', collapsed: true }
    message.blocks.push(block)
  }
  if (block.type === 'text' || block.type === 'thinking') {
    block.text += delta
  }
}

function addPendingUiRequest(event: PendingUiRequest) {
  const requests = pendingUiRequestsBySessionId.value[event.sessionId] ?? []
  const nextRequests = [...requests.filter((item) => item.requestId !== event.requestId), event]
  pendingUiRequestsBySessionId.value[event.sessionId] = nextRequests
  upsertLoadedSession(event.sessionId, { pendingApprovalCount: nextRequests.length })
}

function removePendingUiRequest(sessionId: string, requestId: string) {
  const nextRequests = (pendingUiRequestsBySessionId.value[sessionId] ?? []).filter((item) => item.requestId !== requestId)
  pendingUiRequestsBySessionId.value[sessionId] = nextRequests
  upsertLoadedSession(sessionId, { pendingApprovalCount: nextRequests.length })
}

async function respondToUiRequest(request: PendingUiRequest, value?: string | boolean) {
  let body: UiRequestResponseRequest
  if (request.type === 'ui_select_request') {
    body = { selected: typeof value === 'string' ? value : undefined }
  } else if (request.type === 'ui_input_request') {
    body = { value: typeof value === 'string' ? value : undefined }
  } else {
    body = { confirmed: value === true }
  }

  await agentFetch(sessionUrl(request.sessionId, `/ui-requests/${encodeURIComponent(request.requestId)}/response`), { method: 'POST', body })
  removePendingUiRequest(request.sessionId, request.requestId)
}

function handleEvent(event: ServerEvent) {
  if (event.type === 'hello') {
    hello.value = event
    clientId.value = event.clientId
    return
  }

  if (event.type === 'sessions_snapshot') {
    const previousActiveSessionId = activeSessionId.value
    if (!isDraftSessionId(activeSessionId.value)) {
      activeSessionId.value = event.activeSessionId ?? activeSessionId.value
    }
    loadedSessions.value = event.loadedSessions
    if (event.persistedSessions.length > 0) persistedSessions.value = event.persistedSessions
    if (activeSessionId.value && !isDraftSessionId(activeSessionId.value) && activeSessionId.value !== previousActiveSessionId) {
      void refreshSessionDetails(activeSessionId.value)
    }
    return
  }

  if (event.type === 'active_session_changed') {
    activeSessionId.value = event.sessionId
    upsertLoadedSession(event.sessionId, { file: event.sessionFile ?? event.sessionId, sessionFile: event.sessionFile })
    // HTTP flow already refreshes details; skip redundant WS-triggered fetch
    return
  }

  if (event.type === 'session_control_changed') {
    upsertLoadedSession(event.sessionId, {
      controlledByClientId: event.controlledByClientId,
      controlledByThisClient: event.controlledByThisClient,
    })
    return
  }

  if (event.type === 'message_upsert') {
    upsertMessage(event.sessionId, event.message)
    return
  }

  if (event.type === 'message_block_upsert') {
    upsertMessageBlock(event.sessionId, event.messageId, event.block)
    return
  }

  if (event.type === 'message_block_delta') {
    appendMessageBlockDelta(event.sessionId, event.messageId, event.blockId, event.blockType, event.delta)
    return
  }

  if (event.type === 'status') {
    if (event.sessionId) {
      const state = ensureModelState(event.sessionId)
      const shouldRefreshModelState = !event.isStreaming && (state.pendingModelChange || state.pendingThinkingChange)
      upsertLoadedSession(event.sessionId, {
        isStreaming: event.isStreaming,
        pendingMessageCount: event.pendingMessageCount,
        pendingApprovalCount: event.pendingApprovalCount ?? 0,
      })
      if (shouldRefreshModelState) void refreshModelState(event.sessionId)
    }
    return
  }

  if (event.type === 'ui_select_request' || event.type === 'ui_input_request' || event.type === 'ui_confirm_request') {
    addPendingUiRequest(event)
    toast.add({ title: 'Approval requested', description: event.title, color: 'warning' })
    return
  }

  if (event.type === 'error') {
    lastError.value = event.message
    toast.add({ title: event.code, description: event.message, color: 'error' })
    return
  }

  if (event.type === 'ui_notify') {
    toast.add({ title: event.message, color: event.level === 'error' ? 'error' : event.level === 'warning' ? 'warning' : 'info' })
  }
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${window.location.host}/api/agent/ws`)
  socket.value = ws

  ws.addEventListener('open', () => {
    status.value = 'connected'
  })

  ws.addEventListener('message', (message) => {
    try {
      handleEvent(JSON.parse(message.data) as ServerEvent)
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error)
    }
  })

  ws.addEventListener('close', () => {
    status.value = 'disconnected'
  })

  ws.addEventListener('error', () => {
    status.value = 'error'
    lastError.value = 'WebSocket connection failed.'
  })
}

onMounted(() => {
  refreshState()
    .then(connectWebSocket)
    .catch(() => {
      status.value = 'error'
    })
})

onBeforeUnmount(() => {
  socket.value?.close()
})
</script>

<template>
  <UApp>
    <div class="chat-shell flex h-screen overflow-hidden bg-background text-foreground">
      <!-- Sidebar Drawer Backdrop (only visible on mobile lg:hidden) -->
      <div
        v-if="isSidebarOpen"
        class="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-300 lg:hidden"
        @click="isSidebarOpen = false"
      />

      <!-- Sidebar Drawer Container (Fixed overlay on mobile, Static sidebar on desktop) -->
      <aside
        class="fixed inset-y-0 left-0 z-50 flex w-80 flex-col border-r border-sidebar-border bg-sidebar p-4 text-sidebar-foreground shadow-2xl transition-transform duration-300 ease-in-out lg:static lg:z-0 lg:translate-x-0 lg:shadow-none shrink-0"
        :class="isSidebarOpen ? 'translate-x-0' : '-translate-x-full'"
      >
        <div class="mb-4 flex items-center justify-between px-2 pt-1">
          <div class="flex items-center gap-2">
            <div class="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
              AZ
            </div>
            <div>
              <div class="text-sm font-semibold">Agentaz</div>
              <div class="text-xs text-muted-foreground font-normal">{{ clientId ? `Client ${clientId.slice(0, 8)}` : 'Connecting' }}</div>
            </div>
          </div>
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            size="sm"
            class="text-muted-foreground hover:text-foreground lg:hidden"
            @click="isSidebarOpen = false"
          />
        </div>

        <UButton block color="neutral" variant="soft" class="mb-4 justify-start border border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground hover:bg-secondary" @click="createSessionAndClose">
          <template #leading>
            <UIcon name="i-lucide-plus" class="size-4" />
          </template>
          New session
        </UButton>

        <UButton block color="warning" variant="soft" class="mb-2 justify-start border border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground hover:bg-secondary" @click="loadDummySession">
          <template #leading>
            <UIcon name="i-lucide-flask-conical" class="size-4" />
          </template>
          Load Dummy (300 msgs)
        </UButton>

        <div class="space-y-2 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Sessions
        </div>
        <div class="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
          <button
            v-for="session in unifiedSessions"
            :key="session.id"
            class="w-full rounded-lg px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
            :class="session.isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium' : 'text-sidebar-foreground hover:bg-sidebar-accent'"
            @click="handleSessionClick(session)"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="truncate">{{ session.title }}</span>
              <span class="flex shrink-0 items-center gap-1">
                <UBadge v-if="session.isStreaming" color="success" variant="soft" size="xs">run</UBadge>
                <UBadge v-if="session.pendingApprovalCount" color="warning" variant="soft" size="xs">{{ session.pendingApprovalCount }}</UBadge>
                <UBadge v-if="session.isActive" color="primary" variant="soft" size="xs">open</UBadge>
              </span>
            </div>
            <div class="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground font-normal">
              <span class="truncate">{{ session.sessionId || session.file }}</span>
              <span v-if="session.isLoaded" class="text-[10px] uppercase font-semibold tracking-wider opacity-60">
                {{ session.isActive ? 'opened' : 'working' }}
              </span>
              <span v-else class="text-[10px] uppercase font-semibold tracking-wider opacity-60">
                available
              </span>
            </div>
          </button>
          <div v-if="unifiedSessions.length === 0" class="rounded-lg px-3 py-2 text-sm text-muted-foreground">
            No sessions found
          </div>
        </div>

        <div class="mt-auto pt-4 border-t border-sidebar-border">
          <div class="rounded-lg bg-sidebar-accent p-3 text-xs text-muted-foreground">
            <div class="mb-1 font-medium text-sidebar-foreground">Working directory</div>
            <div class="truncate">{{ hello?.cwd ?? 'Waiting for backend...' }}</div>
          </div>
        </div>
      </aside>

      <main class="flex min-w-0 flex-1 flex-col bg-background text-foreground">
        <header class="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6">
          <div class="flex items-center min-w-0">
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-menu"
              size="sm"
              class="mr-2.5 lg:hidden"
              @click="isSidebarOpen = true"
            />
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h1 class="truncate text-base font-semibold">Agentaz</h1>
                <UBadge v-if="activeLoadedSession" :color="canControlActiveSession ? 'success' : 'neutral'" variant="soft" size="xs">
                  {{ canControlActiveSession ? 'controller' : 'readonly' }}
                </UBadge>
              </div>
              <div class="truncate text-xs text-muted-foreground font-normal">
                {{ isActiveDraftSession ? 'New session' : activeSessionId ? `Session ${activeSessionId}` : 'No active session' }}
              </div>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <UPopover
              :open="isStatusMenuOpen"
              :content="{ side: 'bottom', align: 'end', sideOffset: 8, collisionPadding: 12 }"
              :modal="false"
              class="shrink-0"
              :ui="{
                content: 'w-72 overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl shadow-foreground/10 dark:shadow-black/30',
              }"
              @update:open="onStatusMenuOpenChange"
            >
              <template #content>
                <div class="p-4 space-y-4 text-left">
                  <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    System Status
                  </div>

                  <div class="space-y-2.5">
                    <div class="flex items-center justify-between text-sm">
                      <span class="text-muted-foreground flex items-center gap-1.5">
                        <UIcon name="i-lucide-activity" class="size-4 text-muted-foreground" />
                        Connection
                      </span>
                      <UBadge :color="statusColor" variant="soft" size="xs">{{ statusLabel }}</UBadge>
                    </div>

                    <div class="flex items-center justify-between text-sm">
                      <span class="text-muted-foreground flex items-center gap-1.5">
                        <UIcon name="i-lucide-layers" class="size-4 text-muted-foreground" />
                        Queue
                      </span>
                      <span class="font-medium bg-secondary px-1.5 py-0.5 rounded text-xs text-secondary-foreground font-sans">{{ pendingMessageCount }} messages</span>
                    </div>

                    <div class="flex items-center justify-between text-sm">
                      <span class="text-muted-foreground flex items-center gap-1.5">
                        <UIcon name="i-lucide-shield-alert" class="size-4 text-muted-foreground" />
                        Approvals
                      </span>
                      <UBadge v-if="pendingApprovalCount > 0" color="warning" variant="solid" size="xs">
                        {{ pendingApprovalCount }} pending
                      </UBadge>
                      <span v-else class="font-medium text-xs text-muted-foreground">0 pending</span>
                    </div>

                    <div class="flex items-center justify-between text-sm">
                      <span class="text-muted-foreground flex items-center gap-1.5">
                        <UIcon name="i-lucide-cpu" class="size-4 text-muted-foreground" />
                        Available Models
                      </span>
                      <span class="font-medium text-xs text-muted-foreground font-sans">{{ models.length }} models</span>
                    </div>
                  </div>

                  <div v-if="activeLoadedSession" class="pt-3 border-t border-border space-y-2">
                    <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Session Control
                    </div>

                    <div class="grid grid-cols-2 gap-2">
                      <UButton
                        color="neutral"
                        variant="soft"
                        size="sm"
                        icon="i-lucide-lock"
                        :disabled="!canControlActiveSession"
                        class="justify-center"
                        @click="acquireSession()"
                      >
                        Acquire
                      </UButton>
                      <UButton
                        color="neutral"
                        variant="soft"
                        size="sm"
                        icon="i-lucide-unlock"
                        :disabled="!canControlActiveSession"
                        class="justify-center"
                        @click="releaseSession()"
                      >
                        Release
                      </UButton>
                    </div>

                    <div class="grid grid-cols-2 gap-2">
                      <UButton
                        color="neutral"
                        variant="soft"
                        size="sm"
                        icon="i-lucide-trash-2"
                        :disabled="!canControlActiveSession"
                        class="justify-center"
                        @click="clearActiveQueue"
                      >
                        Clear Queue
                      </UButton>
                      <UButton
                        color="error"
                        variant="soft"
                        size="sm"
                        icon="i-lucide-x-circle"
                        class="justify-center"
                        @click="closeActiveSession"
                      >
                        Close
                      </UButton>
                    </div>
                  </div>
                </div>
              </template>

              <!-- Dropdown Trigger Button -->
              <UButton
                type="button"
                color="neutral"
                variant="outline"
                size="sm"
                class="flex items-center gap-2"
              >
                <!-- Small status indicator dot -->
                <span class="relative flex h-2 w-2">
                  <span
                    v-if="status === 'connected' && isStreaming"
                    class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                    :class="status === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'"
                  ></span>
                  <span
                    class="relative inline-flex rounded-full h-2 w-2"
                    :class="{
                      'bg-emerald-500': status === 'connected',
                      'bg-amber-500': status === 'connecting',
                      'bg-rose-500': status === 'error',
                      'bg-slate-500': status === 'disconnected'
                    }"
                  ></span>
                </span>

                <span class="text-xs font-medium">{{ statusLabel }}</span>
                <UIcon name="i-lucide-chevron-down" class="size-4 shrink-0 opacity-60" />
              </UButton>
            </UPopover>

            <UButton
              color="neutral"
              variant="ghost"
              :icon="isDark ? 'i-lucide-sun' : 'i-lucide-moon'"
              size="sm"
              class="text-foreground hover:bg-accent hover:text-accent-foreground"
              @click="toggleTheme"
            />
          </div>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-6 sm:px-6">
          <div class="mx-auto flex w-full max-w-3xl flex-col gap-5">
            <UAlert
              v-if="lastError"
              color="error"
              variant="soft"
              title="Backend error"
              :description="lastError"
            />

            <section v-if="activePendingUiRequests.length" class="space-y-3 rounded-lg border border-border bg-card p-4">
              <div class="text-sm font-semibold text-card-foreground">Pending UI requests</div>
              <div v-for="request in activePendingUiRequests" :key="request.requestId" class="space-y-2 rounded-lg border border-border p-3 text-sm">
                <div class="font-medium">{{ request.title }}</div>
                <div class="text-xs text-muted-foreground">{{ request.type }} · {{ request.requestId }}</div>
                <div v-if="request.type === 'ui_select_request'" class="flex flex-wrap gap-2">
                  <UButton v-for="option in request.options" :key="option" size="xs" color="neutral" variant="soft" @click="respondToUiRequest(request, option)">
                    {{ option }}
                  </UButton>
                  <UButton size="xs" color="error" variant="soft" @click="respondToUiRequest(request)">Cancel</UButton>
                </div>
                <div v-else-if="request.type === 'ui_confirm_request'" class="flex gap-2">
                  <UButton size="xs" color="primary" @click="respondToUiRequest(request, true)">Confirm</UButton>
                  <UButton size="xs" color="neutral" variant="soft" @click="respondToUiRequest(request, false)">Cancel</UButton>
                </div>
                <div v-else class="flex gap-2">
                  <UButton size="xs" color="primary" @click="respondToUiRequest(request, '')">Submit empty</UButton>
                  <UButton size="xs" color="neutral" variant="soft" @click="respondToUiRequest(request)">Cancel</UButton>
                </div>
              </div>
            </section>

            <section v-if="!hasMessages" class="py-10 text-center text-sm text-muted-foreground">
              Empty session. Send a message to start.
            </section>

            <article
              v-for="message in activeMessages"
              :key="message.id"
              class="flex gap-4 px-4 py-3 hover:bg-muted/30 transition-colors duration-150 rounded-lg text-left"
              style="content-visibility: auto; contain-intrinsic-size: 0 120px"
            >
              <!-- Avatar -->
              <div class="flex-shrink-0">
                <div
                  v-if="message.role === 'user'"
                  class="flex size-9 items-center justify-center rounded-lg bg-secondary text-secondary-foreground font-semibold text-sm"
                >
                  U
                </div>
                <div
                  v-else
                  class="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-semibold text-sm"
                >
                  AZ
                </div>
              </div>

              <!-- Content Area -->
              <div class="flex-1 min-w-0 space-y-1.5">
                <!-- Header -->
                <div class="flex items-baseline gap-2">
                  <span class="text-sm font-semibold text-foreground">
                    {{ roleLabel(message.role) }}
                  </span>
                  <span v-if="message.createdAt" class="text-[11px] text-muted-foreground font-normal font-sans">
                    {{ formatTime(message.createdAt) }}
                  </span>
                </div>

                <!-- Render blocks sequentially -->
                <div class="space-y-1">
                  <div v-for="(block, index) in message.blocks" :key="block.id">
                    <!-- Text Block -->
                    <div v-if="block.type === 'text'">
                      <!-- Special styling for tool messages -->
                      <div v-if="message.role === 'tool'" class="my-1.5 rounded-lg border border-border bg-slate-950 overflow-hidden shadow-inner">
                        <div class="flex items-center justify-between px-3 py-1.5 bg-slate-900 border-b border-slate-800 text-[11px] font-mono text-slate-400 select-none">
                          <span class="flex items-center gap-1.5">
                            <UIcon name="i-lucide-terminal" class="size-3.5 text-slate-400" />
                            Tool Output
                          </span>
                        </div>
                        <div class="p-3 bg-slate-950 font-mono text-xs leading-normal text-left">
                          <pre class="overflow-y-auto max-h-72 whitespace-pre-wrap break-all text-slate-100 font-mono text-[11px] leading-relaxed">{{ block.text }}</pre>
                        </div>
                      </div>

                      <!-- Standard text block -->
	                      <div v-else class="text-sm text-foreground/90 leading-relaxed font-sans whitespace-pre-wrap break-words">
	                        {{ block.text }}
	                      </div>
	                    </div>

	                    <!-- Thinking Block -->
	                    <div v-else-if="block.type === 'thinking' && block.text" class="my-1.5 rounded-lg border border-border bg-muted/20 overflow-hidden">
	                      <button
	                        type="button"
	                        class="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
	                        @click="toggleBlock(getBlockKey(message.id, block, index))"
	                      >
	                        <UIcon name="i-lucide-brain" class="size-4 shrink-0" />
	                        <span>Thinking</span>
	                        <UIcon
	                          :name="isBlockCollapsed(getBlockKey(message.id, block, index), block.collapsed ?? true) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
	                          class="size-3 shrink-0 opacity-60 ml-auto"
	                        />
	                      </button>
	                      <div
	                        v-show="!isBlockCollapsed(getBlockKey(message.id, block, index), block.collapsed ?? true)"
	                        class="border-t border-border/30 p-3"
	                      >
	                        <pre class="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground font-sans">{{ block.text }}</pre>
	                      </div>
	                    </div>

	                    <!-- Tool Call Block -->
	                    <div v-else-if="block.type === 'tool_call'" class="my-1.5 rounded-lg border overflow-hidden" :class="{
	                      'border-amber-500/30 bg-amber-50/5 dark:bg-amber-950/5': block.status === 'pending',
	                      'border-blue-500/30 bg-blue-50/5 dark:bg-blue-950/5': block.status === 'running',
                      'border-emerald-500/30 bg-emerald-50/5 dark:bg-emerald-950/5': block.status === 'completed',
                      'border-red-500/30 bg-red-50/5 dark:bg-red-950/5': block.status === 'error',
                      'border-border bg-muted/10': block.status === 'blocked',
                    }">
                      <button
                        type="button"
                        class="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-muted/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
                        @click="toggleBlock(getBlockKey(message.id, block, index))"
                      >
                        <UIcon name="i-lucide-wrench" class="size-4 shrink-0" :class="{
                          'text-amber-500': block.status === 'pending',
                          'text-blue-500 animate-pulse': block.status === 'running',
                          'text-emerald-500': block.status === 'completed',
                          'text-red-500': block.status === 'error',
                          'text-muted-foreground': block.status === 'blocked',
                        }" />
                        <span class="min-w-0 truncate">{{ block.toolName }}</span>
                        <UBadge size="xs" variant="soft" :color="{
                          'pending': 'warning',
                          'running': 'info',
                          'completed': 'success',
                          'error': 'error',
                          'blocked': 'neutral',
                        }[block.status] as any">
                          {{ block.status }}
                        </UBadge>
	                        <UIcon
	                          :name="isBlockCollapsed(getBlockKey(message.id, block, index), true) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
	                          class="size-3 shrink-0 opacity-60 ml-auto"
	                        />
                      </button>
                      <div
	                        v-show="!isBlockCollapsed(getBlockKey(message.id, block, index), true)"
                        class="border-t border-border/30 p-3"
                      >
                        <pre class="overflow-x-auto text-xs text-foreground/80 font-mono whitespace-pre-wrap break-all leading-relaxed">{{ JSON.stringify(block.input, null, 2) }}</pre>
                      </div>
                    </div>

                    <!-- Tool Result Block -->
                    <div v-else-if="block.type === 'tool_result'" class="my-1.5 rounded-lg border overflow-hidden" :class="block.isError ? 'border-red-500/30 bg-red-50/5 dark:bg-red-950/5' : 'border-border bg-slate-950'">
                      <button
                        type="button"
                        class="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
                        :class="block.isError ? 'text-red-600 dark:text-red-400 hover:bg-red-50/20' : 'text-slate-400 hover:bg-slate-900'"
                        @click="toggleBlock(getBlockKey(message.id, block, index))"
                      >
                        <UIcon name="i-lucide-terminal" class="size-4 shrink-0" />
                        <span>{{ block.isError ? 'Tool Error' : 'Tool Result' }}</span>
	                        <UIcon
	                          :name="isBlockCollapsed(getBlockKey(message.id, block, index), true) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
	                          class="size-3 shrink-0 opacity-60 ml-auto"
	                        />
                      </button>
                      <div
	                        v-show="!isBlockCollapsed(getBlockKey(message.id, block, index), true)"
                        class="border-t border-border/10 p-3"
                      >
                        <pre class="overflow-y-auto max-h-72 whitespace-pre-wrap break-all text-xs font-mono leading-relaxed" :class="block.isError ? 'text-red-700/80 dark:text-red-300/80' : 'text-slate-100'">{{ block.content }}</pre>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </div>

        <div class="shrink-0 px-4 pb-4 sm:px-6 sm:pb-6">
          <MessageComposer
            :prompt-text="promptText"
            :is-streaming="isStreaming"
            :is-connected="status === 'connected' && canSubmitToActiveSession"
            :is-draft-session="isActiveDraftSession"
            :model-options="modelOptions"
            :selected-model-key="selectedModelKey"
            :current-thinking-level="currentThinkingLevel"
            :visible-thinking-options="visibleThinkingOptions"
            :pending-model-change="pendingModelChange"
            :pending-thinking-change="pendingThinkingChange"
            @update:prompt-text="promptText = $event"
            @model-select="handleModelSelect"
            @thinking-select="handleThinkingSelect"
            @submit="submitComposer"
          />
        </div>
      </main>
    </div>
  </UApp>
</template>
