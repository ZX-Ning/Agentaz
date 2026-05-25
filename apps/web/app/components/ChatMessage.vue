<script setup lang="ts">
import security from '@comark/nuxt/plugins/security'
import { ref } from 'vue'
import type { UiBlock, UiMessage } from '../../types/protocol'

type MarkdownNode = string | [string | null, Record<string, unknown>, ...MarkdownNode[]]

const props = defineProps<{
  message: UiMessage
}>()

const collapsedStates = ref<Record<string, boolean>>({})
const markdownOptions = { html: false }
const markdownPlugins = [
  security({
    allowDataImages: false,
    allowedProtocols: ['http', 'https', 'mailto', 'tel'],
    blockedTags: ['iframe', 'object', 'script', 'style'],
  }),
  plainMarkdownOnly(),
]
const allowedMarkdownTags = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'input',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
])

function getBlockKey(block: UiBlock, index: number): string {
  return block.id || `${props.message.id}-${index}`
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

function formatTime(timestamp?: number) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function roleLabel(role: UiMessage['role']) {
  if (role === 'assistant') return 'ai'
  if (role === 'user') return 'You'
  return role
}

function plainMarkdownOnly() {
  return {
    name: 'agentaz-plain-markdown-only',
    post(state: { tree: { nodes: MarkdownNode[] } }) {
      state.tree.nodes = filterMarkdownNodes(state.tree.nodes)
    },
  }
}

function filterMarkdownNodes(nodes: MarkdownNode[]): MarkdownNode[] {
  return nodes.flatMap((node) => {
    if (typeof node === 'string') return [node]

    const [tag, attributes, ...children] = node
    if (tag === null) return []

    const filteredChildren = filterMarkdownNodes(children)
    if (!allowedMarkdownTags.has(tag.toLowerCase())) return filteredChildren

    return [[tag, filterMarkdownAttributes(tag, attributes), ...filteredChildren]]
  })
}

function filterMarkdownAttributes(tag: string, attributes: Record<string, unknown>) {
  const filtered: Record<string, unknown> = {}
  if (attributes.$) filtered.$ = attributes.$

  if (tag === 'a') {
    if (typeof attributes.href === 'string') filtered.href = attributes.href
    if (typeof attributes.title === 'string') filtered.title = attributes.title
  }

  if (tag === 'code' || tag === 'pre') {
    if (typeof attributes.class === 'string') filtered.class = attributes.class
  }

  if (tag === 'input') {
    if (attributes.type === 'checkbox') filtered.type = attributes.type
    if (typeof attributes.checked === 'boolean') filtered.checked = attributes.checked
    if (typeof attributes.disabled === 'boolean') filtered.disabled = attributes.disabled
  }

  return filtered
}
</script>

<template>
  <article
    class="flex gap-4 px-4 py-3 hover:bg-muted/30 transition-colors duration-150 rounded-lg text-left"
    style="content-visibility: auto; contain-intrinsic-size: 0 120px"
  >
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

    <div class="flex-1 min-w-0 space-y-1.5">
      <div class="flex items-baseline gap-2">
        <span class="text-sm font-semibold text-foreground">
          {{ roleLabel(message.role) }}
        </span>
        <span v-if="message.createdAt" class="text-[11px] text-muted-foreground font-normal font-sans">
          {{ formatTime(message.createdAt) }}
        </span>
      </div>

      <div class="space-y-1">
        <div v-for="(block, index) in message.blocks" :key="block.id">
          <!-- Text Block -->
          <div v-if="block.type === 'text'">
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

            <div v-else class="min-w-0 text-sm text-foreground/90 leading-relaxed font-sans break-words">
              <Comark
                :markdown="block.text"
                :options="markdownOptions"
                :plugins="markdownPlugins"
                streaming
                class="max-w-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:break-words [&_code]:break-words [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_ul]:my-2 [&_ul]:pl-5"
              />
            </div>
          </div>

          <!-- Thinking Block -->
          <div v-else-if="block.type === 'thinking' && block.text" class="my-1.5 rounded-lg border border-border bg-muted/20 overflow-hidden">
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
              @click="toggleBlock(getBlockKey(block, index))"
            >
              <UIcon name="i-lucide-brain" class="size-4 shrink-0" />
              <span>Thinking</span>
              <UIcon
                :name="isBlockCollapsed(getBlockKey(block, index), block.collapsed ?? true) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
                class="size-3 shrink-0 opacity-60 ml-auto"
              />
            </button>
            <div
              v-show="!isBlockCollapsed(getBlockKey(block, index), block.collapsed ?? true)"
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
              @click="toggleBlock(getBlockKey(block, index))"
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
                :name="isBlockCollapsed(getBlockKey(block, index), true) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
                class="size-3 shrink-0 opacity-60 ml-auto"
              />
            </button>
            <div
              v-show="!isBlockCollapsed(getBlockKey(block, index), true)"
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
              @click="toggleBlock(getBlockKey(block, index))"
            >
              <UIcon name="i-lucide-terminal" class="size-4 shrink-0" />
              <span>{{ block.isError ? 'Tool Error' : 'Tool Result' }}</span>
              <UIcon
                :name="isBlockCollapsed(getBlockKey(block, index), true) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
                class="size-3 shrink-0 opacity-60 ml-auto"
              />
            </button>
            <div
              v-show="!isBlockCollapsed(getBlockKey(block, index), true)"
              class="border-t border-border/10 p-3"
            >
              <pre class="overflow-y-auto max-h-72 whitespace-pre-wrap break-all text-xs font-mono leading-relaxed" :class="block.isError ? 'text-red-700/80 dark:text-red-300/80' : 'text-slate-100'">{{ block.content }}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  </article>
</template>
