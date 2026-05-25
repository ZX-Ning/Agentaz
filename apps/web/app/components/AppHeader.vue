<script setup lang="ts">
import type { UiLoadedSession } from '../../types/protocol'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

defineProps<{
  isSidebarOpen: boolean
  activeLoadedSession: UiLoadedSession | null
  canControlActiveSession: boolean
  isActiveDraftSession: boolean
  activeSessionId: string | null
  isDark: boolean
  isStatusMenuOpen: boolean
  status: ConnectionStatus
  isStreaming: boolean
  statusColor: 'success' | 'warning' | 'error' | 'neutral'
  statusLabel: string
  pendingMessageCount: number
  pendingApprovalCount: number
  modelsCount: number
}>()

const emit = defineEmits<{
  (event: 'update:isSidebarOpen', value: boolean): void
  (event: 'update:isStatusMenuOpen', value: boolean): void
  (event: 'toggleTheme'): void
  (event: 'acquire'): void
  (event: 'release'): void
  (event: 'clearQueue'): void
  (event: 'closeSession'): void
}>()
</script>

<template>
  <header class="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6">
    <div class="flex items-center min-w-0">
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-menu"
        size="sm"
        class="mr-2.5 lg:hidden"
        @click="emit('update:isSidebarOpen', true)"
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
      <StatusPopover
        :is-open="isStatusMenuOpen"
        :status="status"
        :is-streaming="isStreaming"
        :status-color="statusColor"
        :status-label="statusLabel"
        :pending-message-count="pendingMessageCount"
        :pending-approval-count="pendingApprovalCount"
        :models-count="modelsCount"
        :active-loaded-session="activeLoadedSession"
        :can-control-active-session="canControlActiveSession"
        @update:is-open="emit('update:isStatusMenuOpen', $event)"
        @acquire="emit('acquire')"
        @release="emit('release')"
        @clear-queue="emit('clearQueue')"
        @close-session="emit('closeSession')"
      />

      <UButton
        color="neutral"
        variant="ghost"
        :icon="isDark ? 'i-lucide-sun' : 'i-lucide-moon'"
        size="sm"
        class="text-foreground hover:bg-accent hover:text-accent-foreground"
        @click="emit('toggleTheme')"
      />
    </div>
  </header>
</template>
