<script setup lang="ts">
import type { SessionListItem } from "../types/sessions";

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
  forkFromMessage,
  revertToMessage,
  handleModelSelect,
  handleThinkingSelect,
  submitComposer,
  renameSessionAndClose,
  deleteSessionAndClose,
} = useAgentazAppController();

const isSidebarOpen = ref(false);
const revertTargetMessage = ref<null | {
  id: string;
  rewindEntryId: string;
  text: string;
}>(null);
const activeSessionOperation = ref<null | {
  type: "fork" | "revert";
  messageId: string;
}>(null);
const hasMessages = computed(() => activeMessages.value.length > 0);
const canSubmitToActiveSession = computed(() => Boolean(activeSessionId.value));
const canForkRevertActiveSession = computed(
  () =>
    Boolean(activeLoadedSession.value?.sessionFile) &&
    !isActiveDraftSession.value &&
    !activeLoadedSession.value?.isWorking,
);
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

async function handleForkMessage(message: {
  id: string;
  rewindEntryId?: string;
  blocks?: Array<{ type: string; text?: string }>;
}) {
  if (!message.rewindEntryId || activeSessionOperation.value) return;
  const text = messageText(message);
  activeSessionOperation.value = { type: "fork", messageId: message.id };
  try {
    await forkFromMessage(message.rewindEntryId);
    promptText.value = text;
  } finally {
    activeSessionOperation.value = null;
  }
}

function openRevertConfirmation(message: {
  id: string;
  rewindEntryId?: string;
  blocks?: Array<{ type: string; text?: string }>;
}) {
  if (!message.rewindEntryId || activeSessionOperation.value) return;
  revertTargetMessage.value = {
    id: message.id,
    rewindEntryId: message.rewindEntryId,
    text: messageText(message),
  };
}

function handleRevertModalOpenChange(open: boolean) {
  if (!open) revertTargetMessage.value = null;
}

async function confirmRevert() {
  const target = revertTargetMessage.value;
  if (!target || activeSessionOperation.value) return;
  activeSessionOperation.value = { type: "revert", messageId: target.id };
  try {
    await revertToMessage(target.rewindEntryId);
    promptText.value = target.text;
    revertTargetMessage.value = null;
  } finally {
    activeSessionOperation.value = null;
  }
}

function messageText(message: {
  blocks?: Array<{ type: string; text?: string }>;
}) {
  return (
    message.blocks
      ?.filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("\n\n") ?? ""
  ).trim();
}

function isMessageOperationPending(type: "fork" | "revert", messageId: string) {
  return (
    activeSessionOperation.value?.type === type &&
    activeSessionOperation.value.messageId === messageId
  );
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
            :can-fork-revert="canForkRevertActiveSession"
            :is-forking="isMessageOperationPending('fork', message.id)"
            :is-reverting="isMessageOperationPending('revert', message.id)"
            @fork="handleForkMessage"
            @revert="openRevertConfirmation"
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
        class="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm text-card-foreground shadow-xl shadow-foreground/10 dark:shadow-foreground/10"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-5 animate-spin text-muted-foreground"
        />
        <span>Loading sessions...</span>
      </div>
    </div>

    <UModal
      :open="Boolean(revertTargetMessage)"
      title="Revert session"
      :ui="{ content: 'sm:max-w-lg' }"
      @update:open="handleRevertModalOpenChange"
    >
      <template #body>
        <div class="space-y-4">
          <p class="text-sm leading-6 text-muted-foreground">
            Remove this user message from the current session and move its text
            back to the composer? Messages after it on the current path will no
            longer be shown in this session.
          </p>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              type="button"
              @click="revertTargetMessage = null"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              type="button"
              :loading="activeSessionOperation?.type === 'revert'"
              @click="confirmRevert"
            >
              Revert
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
