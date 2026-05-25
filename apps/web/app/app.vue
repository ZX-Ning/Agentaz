<script setup lang="ts">
const {
  status,
  hello,
  clientId,
  activeSessionId,
  activeLoadedSession,
  activeSessionTitle,
  isActiveDraftSession,
  isDark,
  isStatusMenuOpen,
  isSidebarOpen,
  isStreaming,
  pendingMessageCount,
  pendingApprovalCount,
  promptText,
  lastError,
  models,
  canSubmitToActiveSession,
  hasMessages,
  activeMessages,
  activePendingUiRequests,
  activeExtensionWidgets,
  unifiedSessions,
  modelOptions,
  selectedModelKey,
  currentThinkingLevel,
  visibleThinkingOptions,
  pendingModelChange,
  pendingThinkingChange,
  statusColor,
  statusLabel,
  handleSessionClick,
  toggleTheme,
  createSessionAndClose,
  loadDummySession,
  clearActiveQueue,
  respondToUiRequest,
  handleModelSelect,
  handleThinkingSelect,
  submitComposer,
} = useAgentazAppController();
</script>

<template>
  <UApp>
    <div
      class="chat-shell flex h-screen overflow-hidden bg-background text-foreground"
    >
      <AppSidebar
        v-model:open="isSidebarOpen"
        :client-id="clientId"
        :sessions="unifiedSessions"
        :working-dir="hello?.cwd ?? 'Waiting for backend...'"
        @create="createSessionAndClose"
        @load-dummy="loadDummySession"
        @select="handleSessionClick"
      />

      <main class="flex min-w-0 flex-1 flex-col bg-background text-foreground">
        <AppHeader
          :is-sidebar-open="isSidebarOpen"
          :active-loaded-session="activeLoadedSession"
          :session-title="activeSessionTitle"
          :is-active-draft-session="isActiveDraftSession"
          :active-session-id="activeSessionId"
          :is-dark="isDark"
          :is-status-menu-open="isStatusMenuOpen"
          :status="status"
          :is-streaming="isStreaming"
          :status-color="statusColor"
          :status-label="statusLabel"
          :pending-message-count="pendingMessageCount"
          :pending-approval-count="pendingApprovalCount"
          :models-count="models.length"
          @update:is-sidebar-open="isSidebarOpen = $event"
          @update:is-status-menu-open="isStatusMenuOpen = $event"
          @toggle-theme="toggleTheme"
          @clear-queue="clearActiveQueue"
        />

        <div
          class="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-6 sm:px-6"
        >
          <div class="mx-auto flex w-full max-w-3xl flex-col gap-5">
            <UAlert
              v-if="lastError"
              color="error"
              variant="soft"
              title="Backend error"
              :description="lastError"
            />

            <PendingUiRequests
              :requests="activePendingUiRequests"
              @respond="respondToUiRequest"
            />

            <ExtensionWidgets :widgets="activeExtensionWidgets" />

            <section
              v-if="!hasMessages"
              class="py-10 text-center text-sm text-muted-foreground"
            >
              Empty session. Send a message to start.
            </section>

            <ChatMessage
              v-for="message in activeMessages"
              :key="message.id"
              :message="message"
            />
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
