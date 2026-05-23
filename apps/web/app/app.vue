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

const thinkingOptions: Array<{ value: ThinkingLevel, label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
]

const activeLoadedSession = computed(() => loadedSessions.value.find((session) => session.sessionId === activeSessionId.value) ?? null)
const activeMessages = computed(() => activeSessionId.value ? messagesBySessionId.value[activeSessionId.value] ?? [] : [])
const activeModelState = computed(() => activeSessionId.value ? ensureModelState(activeSessionId.value) : defaultModelState())
const activePendingUiRequests = computed(() => activeSessionId.value ? pendingUiRequestsBySessionId.value[activeSessionId.value] ?? [] : [])
const recentSessions = computed(() => persistedSessions.value.slice(0, 10))
const models = computed(() => activeModelState.value.models)
const currentModel = computed(() => activeModelState.value.currentModel)
const currentThinkingLevel = computed(() => activeModelState.value.thinkingLevel)
const availableThinkingLevels = computed(() => activeModelState.value.availableThinkingLevels)
const pendingModelChange = computed(() => activeModelState.value.pendingModelChange)
const pendingThinkingChange = computed(() => activeModelState.value.pendingThinkingChange)
const isStreaming = computed(() => Boolean(activeLoadedSession.value?.isStreaming))
const pendingMessageCount = computed(() => activeLoadedSession.value?.pendingMessageCount ?? 0)
const pendingApprovalCount = computed(() => activeLoadedSession.value?.pendingApprovalCount ?? activePendingUiRequests.value.length)
const canControlActiveSession = computed(() => Boolean(activeSessionId.value))
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

function ensureModelState(sessionId: string) {
  modelStateBySessionId.value[sessionId] ??= defaultModelState()
  return modelStateBySessionId.value[sessionId]
}

function ensureMessageBucket(sessionId: string) {
  messagesBySessionId.value[sessionId] ??= []
  return messagesBySessionId.value[sessionId]
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

function blockText(message: UiMessage) {
  return message.blocks
    .map((block) => {
      if (block.type === 'text' || block.type === 'thinking') return block.text
      if (block.type === 'tool_call') return `[tool:${block.toolName}] ${block.status}`
      if (block.type === 'tool_result') return block.content
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function sessionTitle(session: UiLoadedSession | UiSessionSummary) {
  return session.firstMessage || session.name || ('sessionId' in session ? session.sessionId.slice(0, 8) : 'Untitled session')
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
  activeSessionId.value = state.activeSessionId ?? null
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
  }
}

async function refreshSessionDetails(sessionId: string) {
  await Promise.all([
    refreshHistory(sessionId),
    refreshModelState(sessionId),
  ])
}

async function refreshHistory(sessionId: string) {
  const history = await agentFetch<SessionHistoryResponse>(sessionUrl(sessionId, '/history'))
  messagesBySessionId.value[sessionId] = history.messages
}

async function refreshModelState(sessionId: string) {
  applyModelState(await agentFetch<ModelStateResponse>(sessionUrl(sessionId, '/models')))
}

async function postSessionOperation(path: string, options?: Parameters<typeof $fetch<SessionOperationResponse>>[1]) {
  const state = await agentFetch<SessionOperationResponse>(path, options)
  applyState(state)
  if (state.activeSessionId) await refreshSessionDetails(state.activeSessionId)
}

async function sendPrompt() {
  const sessionId = activeSessionId.value
  const text = promptText.value.trim()
  if (!sessionId || !text) return

  ensureMessageBucket(sessionId).push({
    id: `local-${Date.now()}`,
    role: 'user',
    blocks: [{ type: 'text', text }],
    createdAt: Date.now(),
  })

  const body: MessageSubmitRequest = { mode: 'prompt', text }
  await agentFetch(sessionUrl(sessionId, '/messages'), { method: 'POST', body })
  promptText.value = ''
}

async function submitComposer() {
  const sessionId = activeSessionId.value
  if (!sessionId) return
  if (isStreaming.value) {
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

  const body: ModelSetRequest = { provider: option.model.provider, id: option.model.id }
  applyModelState(await agentFetch<ModelStateResponse>(sessionUrl(sessionId, '/model'), { method: 'PUT', body }))
}

async function handleThinkingSelect(value: unknown) {
  const sessionId = activeSessionId.value
  if (!sessionId || !isThinkingLevel(value)) return
  applyModelState(await agentFetch<ModelStateResponse>(sessionUrl(sessionId, '/thinking'), { method: 'PUT', body: { level: value } }))
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return thinkingOptions.some((option) => option.value === value)
}

async function createSession() {
  await postSessionOperation('/api/agent/sessions', { method: 'POST' })
}

async function openPersistedSession(sessionFile: string) {
  await postSessionOperation('/api/agent/sessions', { method: 'POST', body: { sessionFile } })
}

async function focusSession(sessionId: string) {
  activeSessionId.value = sessionId
  await postSessionOperation(sessionUrl(sessionId, '/focus'), { method: 'POST' })
}

async function acquireSession(sessionId = activeSessionId.value) {
  if (sessionId) await postSessionOperation(sessionUrl(sessionId, '/control'), { method: 'POST', body: { action: 'acquire' } })
}

async function releaseSession(sessionId = activeSessionId.value) {
  if (sessionId) await postSessionOperation(sessionUrl(sessionId, '/control'), { method: 'POST', body: { action: 'release' } })
}

async function clearActiveQueue() {
  if (activeSessionId.value) await agentFetch(sessionUrl(activeSessionId.value, '/queue/clear'), { method: 'POST' })
}

async function closeActiveSession() {
  if (!activeSessionId.value) return
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
    activeSessionId.value = event.activeSessionId ?? activeSessionId.value
    loadedSessions.value = event.loadedSessions
    if (event.persistedSessions.length > 0) persistedSessions.value = event.persistedSessions
    if (activeSessionId.value && activeSessionId.value !== previousActiveSessionId) {
      void refreshSessionDetails(activeSessionId.value)
    }
    return
  }

  if (event.type === 'active_session_changed') {
    activeSessionId.value = event.sessionId
    upsertLoadedSession(event.sessionId, { file: event.sessionFile ?? event.sessionId, sessionFile: event.sessionFile })
    void refreshSessionDetails(event.sessionId)
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
    const bucket = ensureMessageBucket(event.sessionId)
    const index = bucket.findIndex((message) => message.id === event.message.id)
    if (index === -1) bucket.push(event.message)
    else bucket[index] = event.message
    return
  }

  if (event.type === 'message_delta') {
    const bucket = ensureMessageBucket(event.sessionId)
    let message = bucket.find((item) => item.id === event.messageId)
    if (!message) {
      message = { id: event.messageId, role: 'assistant', blocks: [], createdAt: Date.now() }
      bucket.push(message)
    }
    const block = message.blocks.find((item) => item.type === event.blockType)
    if (block && (block.type === 'text' || block.type === 'thinking')) block.text += event.delta
    else message.blocks.push({ type: event.blockType, text: event.delta })
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
      <aside class="hidden w-80 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-3 text-sidebar-foreground lg:flex">
        <div class="mb-4 flex items-center justify-between px-2 pt-1">
          <div class="flex items-center gap-2">
            <div class="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
              AZ
            </div>
            <div>
              <div class="text-sm font-semibold">Agentaz</div>
              <div class="text-xs text-muted-foreground">{{ clientId ? `Client ${clientId.slice(0, 8)}` : 'Connecting' }}</div>
            </div>
          </div>
        </div>

        <UButton block color="neutral" variant="soft" class="mb-4 justify-start border border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground hover:bg-secondary" @click="createSession">
          New loaded session
        </UButton>

        <div class="space-y-2 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Status
        </div>
        <div class="mt-2 space-y-2 rounded-lg border border-sidebar-border bg-sidebar-accent p-3 text-sm text-sidebar-accent-foreground">
          <div class="flex items-center justify-between gap-3">
            <span class="text-muted-foreground">Connection</span>
            <UBadge :color="statusColor" variant="soft" size="xs">{{ statusLabel }}</UBadge>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-muted-foreground">Queue</span>
            <span class="font-medium">{{ pendingMessageCount }}</span>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-muted-foreground">Approvals</span>
            <span class="font-medium">{{ pendingApprovalCount }}</span>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-muted-foreground">Models</span>
            <span class="font-medium">{{ models.length }}</span>
          </div>
        </div>

        <div class="mt-6 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Loaded sessions
        </div>
        <div class="mt-2 space-y-1">
          <button
            v-for="session in loadedSessions"
            :key="session.sessionId"
            class="w-full rounded-lg px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
            :class="session.sessionId === activeSessionId ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground hover:bg-sidebar-accent'"
            @click="focusSession(session.sessionId)"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="truncate">{{ sessionTitle(session) }}</span>
              <span class="flex shrink-0 items-center gap-1">
                <UBadge v-if="session.isStreaming" color="success" variant="soft" size="xs">run</UBadge>
                <UBadge v-if="session.pendingApprovalCount" color="warning" variant="soft" size="xs">{{ session.pendingApprovalCount }}</UBadge>
              </span>
            </div>
            <div class="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span class="truncate">{{ session.sessionId }}</span>
              <span>{{ session.controlledByThisClient ? 'control' : session.controlledByClientId ? 'readonly' : 'free' }}</span>
            </div>
          </button>
          <div v-if="loadedSessions.length === 0" class="rounded-lg px-3 py-2 text-sm text-muted-foreground">
            No loaded sessions
          </div>
        </div>

        <div class="mt-4 grid grid-cols-2 gap-2">
          <UButton color="neutral" variant="soft" size="xs" @click="acquireSession()">Acquire</UButton>
          <UButton color="neutral" variant="soft" size="xs" @click="releaseSession()">Release</UButton>
          <UButton color="neutral" variant="soft" size="xs" @click="clearActiveQueue">Clear queue</UButton>
          <UButton color="error" variant="soft" size="xs" @click="closeActiveSession">Close</UButton>
        </div>

        <div class="mt-6 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Persisted sessions
        </div>
        <div class="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
          <button
            v-for="session in recentSessions"
            :key="session.file"
            class="w-full truncate rounded-lg px-3 py-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
            @click="openPersistedSession(session.file)"
          >
            {{ sessionTitle(session) }}
          </button>
          <div v-if="recentSessions.length === 0" class="rounded-lg px-3 py-2 text-sm text-muted-foreground">
            No persisted sessions yet
          </div>
        </div>

        <div class="mt-4 rounded-lg border border-sidebar-border bg-sidebar-accent p-3 text-xs text-muted-foreground">
          <div class="mb-1 font-medium text-sidebar-foreground">Working directory</div>
          <div class="truncate">{{ hello?.cwd ?? 'Waiting for backend...' }}</div>
        </div>
      </aside>

      <main class="flex min-w-0 flex-1 flex-col bg-background text-foreground">
        <header class="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h1 class="truncate text-base font-semibold">Agentaz</h1>
              <UBadge :color="statusColor" variant="soft" size="xs">{{ statusLabel }}</UBadge>
              <UBadge v-if="activeLoadedSession" :color="canControlActiveSession ? 'success' : 'neutral'" variant="soft" size="xs">
                {{ canControlActiveSession ? 'controller' : 'readonly' }}
              </UBadge>
            </div>
            <div class="truncate text-xs text-muted-foreground">
              {{ activeSessionId ? `Session ${activeSessionId}` : 'No active session' }}
            </div>
          </div>

          <div class="flex items-center gap-2">
            <UButton color="neutral" variant="ghost" size="sm" class="text-foreground hover:bg-accent hover:text-accent-foreground" @click="toggleTheme">
              {{ isDark ? 'Light' : 'Dark' }}
            </UButton>
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
              class="flex gap-3"
              :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <div v-if="message.role !== 'user'" class="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold text-secondary-foreground">
                AZ
              </div>

              <div class="max-w-[82%] space-y-1 sm:max-w-[74%]">
                <div class="px-1 text-xs font-medium text-muted-foreground">
                  {{ roleLabel(message.role) }}
                </div>
                <div
                  class="rounded-lg border border-border px-4 py-3 text-sm leading-6"
                  :class="message.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-card text-card-foreground'"
                >
                  <pre class="whitespace-pre-wrap break-words font-sans text-inherit">{{ blockText(message) }}</pre>
                </div>
              </div>
            </article>
          </div>
        </div>

        <div class="shrink-0 px-4 pb-4 sm:px-6 sm:pb-6">
          <MessageComposer
            :prompt-text="promptText"
            :is-streaming="isStreaming"
            :is-connected="status === 'connected' && canControlActiveSession"
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
