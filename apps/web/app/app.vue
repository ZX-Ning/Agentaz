<script setup lang="ts">
import type { ClientCommand, ServerEvent, ServerHello, ThinkingLevel, UiMessage, UiModel, UiSessionSummary } from '../types/protocol'

const toast = useToast()
const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

const status = ref<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting')
const hello = ref<ServerHello | null>(null)
const messages = ref<UiMessage[]>([])
const sessions = ref<UiSessionSummary[]>([])
const models = ref<UiModel[]>([])
const currentModel = ref<UiModel | null>(null)
const currentThinkingLevel = ref<ThinkingLevel>('off')
const availableThinkingLevels = ref<ThinkingLevel[]>(['off'])
const pendingModelChange = ref(false)
const pendingThinkingChange = ref(false)
const isStreaming = ref(false)
const pendingMessageCount = ref(0)
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

const recentSessions = computed(() => sessions.value.slice(0, 6))
const hasMessages = computed(() => messages.value.length > 0)
const selectedModelKey = computed(() => currentModel.value ? modelKey(currentModel.value) : '')
const modelOptions = computed(() => models.value.map((model) => ({
  value: modelKey(model),
  label: `${model.name || model.id} · ${model.provider}`,
  description: `${model.provider}/${model.id}`,
  model,
})))
const visibleThinkingOptions = computed(() => {
  const levels = availableThinkingLevels.value.length > 0 ? availableThinkingLevels.value : ['off']
  return thinkingOptions.filter((option) => levels.includes(option.value))
})

function modelKey(model: UiModel) {
  return JSON.stringify([model.provider, model.id])
}

function roleLabel(role: UiMessage['role']) {
  if (role === 'assistant') return 'Pi'
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

function send(command: ClientCommand) {
  const ws = socket.value
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast.add({ title: 'Agent is not connected', color: 'warning' })
    return false
  }
  ws.send(JSON.stringify(command))
  return true
}

function sendPrompt() {
  const text = promptText.value.trim()
  if (!text) return
  messages.value.push({
    id: `local-${Date.now()}`,
    role: 'user',
    blocks: [{ type: 'text', text }],
    createdAt: Date.now(),
  })
  send({ type: 'prompt', text })
  promptText.value = ''
}

function submitComposer() {
  if (isStreaming.value) {
    send({ type: 'abort' })
    return
  }
  sendPrompt()
}

function toggleTheme() {
  colorMode.preference = isDark.value ? 'light' : 'dark'
}

function updateThinkingState(level?: ThinkingLevel, levels?: ThinkingLevel[]) {
  if (levels?.length) availableThinkingLevels.value = levels
  if (level) currentThinkingLevel.value = level
  if (!availableThinkingLevels.value.includes(currentThinkingLevel.value)) {
    currentThinkingLevel.value = availableThinkingLevels.value[0] ?? 'off'
  }
}

function handleModelSelect(value: unknown) {
  if (typeof value !== 'string') return

  const option = modelOptions.value.find((item) => item.value === value)
  if (!option || modelKey(option.model) === selectedModelKey.value) return

  if (send({ type: 'model_set', provider: option.model.provider, id: option.model.id })) {
    currentModel.value = option.model
    pendingModelChange.value = true
  }
}

function handleThinkingSelect(value: unknown) {
  if (!isThinkingLevel(value)) return

  const level = value
  if (level === currentThinkingLevel.value) return

  if (send({ type: 'thinking_set', level })) {
    currentThinkingLevel.value = level
    pendingThinkingChange.value = true
  }
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return thinkingOptions.some((option) => option.value === value)
}

function handleEvent(event: ServerEvent) {
  if (event.type === 'hello') {
    hello.value = event
    return
  }

  if (event.type === 'history') {
    messages.value = event.messages
    return
  }

  if (event.type === 'message_upsert') {
    const index = messages.value.findIndex((message) => message.id === event.message.id)
    if (index === -1) messages.value.push(event.message)
    else messages.value[index] = event.message
    return
  }

  if (event.type === 'message_delta') {
    let message = messages.value.find((item) => item.id === event.messageId)
    if (!message) {
      message = { id: event.messageId, role: 'assistant', blocks: [], createdAt: Date.now() }
      messages.value.push(message)
    }

    const block = message.blocks.find((item) => item.type === event.blockType)
    if (block && (block.type === 'text' || block.type === 'thinking')) block.text += event.delta
    else message.blocks.push({ type: event.blockType, text: event.delta })
    return
  }

  if (event.type === 'status') {
    isStreaming.value = event.isStreaming
    pendingMessageCount.value = event.pendingMessageCount
    return
  }

  if (event.type === 'model_list_result') {
    models.value = event.models
    currentModel.value = event.current ?? null
    pendingModelChange.value = false
    pendingThinkingChange.value = false
    updateThinkingState(event.thinkingLevel, event.availableThinkingLevels)
    return
  }

  if (event.type === 'model_changed') {
    currentModel.value = event.model
    pendingModelChange.value = Boolean(event.pending)
    updateThinkingState(event.thinkingLevel, event.availableThinkingLevels)
    return
  }

  if (event.type === 'thinking_changed') {
    updateThinkingState(event.level)
    pendingThinkingChange.value = Boolean(event.pending)
    return
  }

  if (event.type === 'session_list_result') {
    sessions.value = event.sessions
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

onMounted(() => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${window.location.host}/api/agent/ws`)
  socket.value = ws

  ws.addEventListener('open', () => {
    status.value = 'connected'
    send({ type: 'model_list' })
    send({ type: 'session_list' })
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
})

onBeforeUnmount(() => {
  socket.value?.close()
})
</script>

<template>
  <UApp>
    <div class="chat-shell flex h-screen overflow-hidden bg-background text-foreground">
      <aside class="hidden w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-3 text-sidebar-foreground lg:flex">
        <div class="mb-4 flex items-center justify-between px-2 pt-1">
          <div class="flex items-center gap-2">
            <div class="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
              π
            </div>
            <div>
              <div class="text-sm font-semibold">Agentaz</div>
              <div class="text-xs text-muted-foreground">Local Pi agent</div>
            </div>
          </div>
        </div>

        <UButton block color="neutral" variant="soft" class="mb-4 justify-start border border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground hover:bg-secondary" @click="send({ type: 'session_new' })">
          New chat
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
            <span class="text-muted-foreground">Models</span>
            <span class="font-medium">{{ models.length }}</span>
          </div>
        </div>

        <div class="mt-6 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Recent sessions
        </div>
        <div class="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
          <button
            v-for="session in recentSessions"
            :key="session.file"
            class="w-full truncate rounded-lg px-3 py-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
            @click="send({ type: 'session_open', sessionFile: session.file, abortCurrent: true })"
          >
            {{ session.firstMessage || session.name || 'Untitled session' }}
          </button>
          <div v-if="recentSessions.length === 0" class="rounded-lg px-3 py-2 text-sm text-muted-foreground">
            No sessions yet
          </div>
        </div>

        <div class="mt-4 rounded-lg border border-sidebar-border bg-sidebar-accent p-3 text-xs text-muted-foreground">
          <div class="mb-1 font-medium text-sidebar-foreground">Working directory</div>
          <div class="truncate">{{ hello?.cwd ?? 'Waiting for backend…' }}</div>
        </div>
      </aside>

      <main class="flex min-w-0 flex-1 flex-col bg-background text-foreground">
        <header class="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h1 class="truncate text-base font-semibold">Pi Web Agent</h1>
              <UBadge :color="statusColor" variant="soft" size="xs" class="lg:hidden">{{ statusLabel }}</UBadge>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <UButton color="neutral" variant="ghost" size="sm" class="text-foreground hover:bg-accent hover:text-accent-foreground" @click="toggleTheme">
              {{ isDark ? 'Light' : 'Dark' }}
            </UButton>
            <UButton color="neutral" variant="ghost" size="sm" class="text-foreground hover:bg-accent hover:text-accent-foreground" @click="send({ type: 'clear_queue' })">
              Clear queue
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

            <section v-if="!hasMessages" class="py-10 text-center text-sm text-muted-foreground">
              Empty session. Send a message to start.
            </section>

            <article
              v-for="message in messages"
              :key="message.id"
              class="flex gap-3"
              :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <div v-if="message.role !== 'user'" class="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold text-secondary-foreground">
                π
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
            :is-connected="status === 'connected'"
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
