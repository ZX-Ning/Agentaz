<script setup lang="ts">
import type { UiLoadedSession } from "../../types/protocol";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

const props = defineProps<{
  isSidebarOpen: boolean;
  activeLoadedSession: UiLoadedSession | null;
  sessionTitle: string;
  isActiveDraftSession: boolean;
  activeSessionId: string | null;
  status: ConnectionStatus;
  isStreaming: boolean;
  pendingMessageCount: number;
  pendingApprovalCount: number;
  modelsCount: number;
}>();

const emit = defineEmits<{
  (event: "update:isSidebarOpen", value: boolean): void;
  (event: "clearQueue"): void;
}>();

const isStatusMenuOpen = ref(false);
const colorMode = useColorMode();
const isDark = computed(() => colorMode.value === "dark");
const statusColor = computed(() => {
  if (props.status === "connected") return "success";
  if (props.status === "connecting") return "warning";
  if (props.status === "error") return "error";
  return "neutral";
});
const statusLabel = computed(() => {
  if (props.status === "connected")
    return props.isStreaming ? "Streaming" : "Connected";
  if (props.status === "connecting") return "Connecting";
  if (props.status === "error") return "Error";
  return "Disconnected";
});

function toggleTheme() {
  colorMode.preference = isDark.value ? "light" : "dark";
}
</script>

<template>
  <header
    class="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6"
  >
    <div class="flex items-center min-w-0">
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-menu"
        size="sm"
        class="mr-2.5"
        @click="emit('update:isSidebarOpen', !isSidebarOpen)"
      />
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <h1 class="truncate text-base font-semibold">
            {{ sessionTitle }}
          </h1>
          <UBadge
            v-if="activeLoadedSession?.controlOwnerClientId"
            :color="
              activeLoadedSession.controlledByCurrentClient
                ? 'success'
                : 'warning'
            "
            variant="soft"
            size="xs"
          >
            {{
              activeLoadedSession.controlledByCurrentClient
                ? "working here"
                : "working elsewhere"
            }}
          </UBadge>
        </div>
        <div class="truncate text-xs text-muted-foreground font-normal">
          {{
            isActiveDraftSession
              ? "New session"
              : activeSessionId
                ? `Session ${activeSessionId}`
                : "No active session"
          }}
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
        @update:is-open="isStatusMenuOpen = $event"
        @clear-queue="emit('clearQueue')"
      />

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
</template>
