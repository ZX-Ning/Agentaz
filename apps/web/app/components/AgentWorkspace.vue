<script setup lang="ts">
import type { SessionListItem } from "../../types/protocol";

const emit = defineEmits<{
  (event: "logout"): void;
}>();

const {
  status,
  hello,
  clientId,
  activeSessionId,
  activeLoadedSession,
  activeSessionTitle,
  isActiveDraftSession,
  isStreaming,
  pendingMessageCount,
  pendingApprovalCount,
  promptText,
  lastError,
  models,
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
  handleSessionClick,
  createSessionAndClose,
  // loadDummySession,
  clearActiveQueue,
  respondToUiRequest,
  handleModelSelect,
  handleThinkingSelect,
  submitComposer,
  renameSessionAndClose,
  deleteSessionAndClose,
} = useAgentazAppController();

const isSidebarOpen = ref(false);
const hasMessages = computed(() => activeMessages.value.length > 0);
const canSubmitToActiveSession = computed(() => Boolean(activeSessionId.value));
const isInitialSessionListLoading = computed(
  () =>
    !hello.value &&
    (status.value === "connecting" || status.value === "connected"),
);
const pageTitle = computed(() => `Agentaz-${activeSessionTitle.value}`);

function closeSidebarOnMobile() {
  if (window.matchMedia("(max-width: 1023px)").matches)
    isSidebarOpen.value = false;
}

async function handleSidebarSessionSelect(session: SessionListItem) {
  await handleSessionClick(session);
  closeSidebarOnMobile();
}

async function handleSidebarCreate() {
  await createSessionAndClose();
  closeSidebarOnMobile();
}

async function handleSidebarSessionRename(payload: {
  session: SessionListItem;
  name: string;
}) {
  if (!payload.session.file) return;
  await renameSessionAndClose(payload.session.file, payload.name);
}

async function handleSidebarSessionDelete(session: SessionListItem) {
  await deleteSessionAndClose(session);
  closeSidebarOnMobile();
}

// function handleSidebarLoadDummy() {
//   loadDummySession();
//   closeSidebarOnMobile();
// }

onMounted(() => {
  isSidebarOpen.value = window.matchMedia("(min-width: 1024px)").matches;
});

useHead({
  title: pageTitle,
});
</script>

<template>
  <div
    class="chat-shell relative flex overflow-hidden bg-background text-foreground"
  >
    <AppSidebar
      v-model:open="isSidebarOpen"
      :client-id="clientId"
      :sessions="unifiedSessions"
      :working-dir="hello?.cwd ?? 'Waiting for backend...'"
      @create="handleSidebarCreate"
      @select="handleSidebarSessionSelect"
      @rename="handleSidebarSessionRename"
      @delete="handleSidebarSessionDelete"
    />

    <main
      class="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
    >
      <AppHeader
        :is-sidebar-open="isSidebarOpen"
        :active-loaded-session="activeLoadedSession"
        :session-title="activeSessionTitle"
        :is-active-draft-session="isActiveDraftSession"
        :active-session-id="activeSessionId"
        :status="status"
        :is-streaming="isStreaming"
        :pending-message-count="pendingMessageCount"
        :pending-approval-count="pendingApprovalCount"
        :models-count="models.length"
        @update:is-sidebar-open="isSidebarOpen = $event"
        @clear-queue="clearActiveQueue"
        @logout="emit('logout')"
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

      <div
        class="shrink-0 space-y-3 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-6 sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
      >
        <div class="mx-auto w-full max-w-3xl">
          <PendingUiRequests
            :requests="activePendingUiRequests"
            @respond="respondToUiRequest"
          />
        </div>

        <div class="mx-auto w-full max-w-3xl">
          <ExtensionWidgets :widgets="activeExtensionWidgets" />
        </div>

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

    <div
      v-if="isInitialSessionListLoading"
      class="absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-grayscale backdrop-blur-[1px]"
    >
      <div
        class="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm text-card-foreground shadow-xl shadow-foreground/10 dark:shadow-black/30"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-5 animate-spin text-muted-foreground"
        />
        <span>Loading sessions...</span>
      </div>
    </div>
  </div>
</template>
