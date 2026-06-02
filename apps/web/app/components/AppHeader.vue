<script setup lang="ts">
import type { UiLoadedSession } from "../../types/protocol";

declare function useColorMode(): {
  value: string;
  preference: string;
};

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
  autoStickToBottom: boolean;
}>();

const emit = defineEmits<{
  (
    event: "update:isSidebarOpen" | "update:autoStickToBottom",
    value: boolean,
  ): void;
  (event: "clearQueue" | "logout"): void;
}>();

const isStatusMenuOpen = ref(false);
const isMobileActionsOpen = ref(false);
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

function toggleAutoStickToBottom() {
  emit("update:autoStickToBottom", !props.autoStickToBottom);
  isMobileActionsOpen.value = false;
}

function handleMobileThemeToggle() {
  toggleTheme();
  isMobileActionsOpen.value = false;
}

function handleMobileLogout() {
  isMobileActionsOpen.value = false;
  emit("logout");
}
</script>

<template>
  <header
    class="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-background/90 px-2.5 py-2 backdrop-blur sm:h-14 sm:px-6 sm:py-0"
  >
    <div class="flex min-w-0 flex-1 items-center">
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-menu"
        size="sm"
        class="mr-1.5 shrink-0 sm:mr-2.5"
        @click="emit('update:isSidebarOpen', !isSidebarOpen)"
      />
      <div class="min-w-0">
        <div class="flex min-w-0 items-center gap-2">
          <h1 class="truncate text-sm font-semibold sm:text-base">
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
            class="hidden sm:inline-flex"
          >
            {{
              activeLoadedSession.controlledByCurrentClient
                ? "working here"
                : "working elsewhere"
            }}
          </UBadge>
        </div>
        <div
          class="hidden truncate text-xs font-normal text-muted-foreground sm:block"
        >
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

    <div class="flex shrink-0 items-center gap-1.5 sm:gap-2">
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
        type="button"
        color="neutral"
        variant="ghost"
        icon="i-lucide-arrow-down-to-line"
        size="sm"
        :aria-pressed="autoStickToBottom"
        aria-label="Keep transcript at bottom"
        class="hidden text-foreground hover:bg-accent hover:text-accent-foreground sm:inline-flex"
        :class="
          autoStickToBottom ? 'bg-accent shadow-inner shadow-primary' : ''
        "
        @click="toggleAutoStickToBottom"
      />

      <UButton
        color="neutral"
        variant="ghost"
        :icon="isDark ? 'i-lucide-sun' : 'i-lucide-moon'"
        size="sm"
        class="hidden text-foreground hover:bg-accent hover:text-accent-foreground sm:inline-flex"
        @click="toggleTheme"
      />

      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-log-out"
        size="sm"
        class="hidden text-foreground hover:bg-accent hover:text-accent-foreground sm:inline-flex"
        @click="emit('logout')"
      />

      <UPopover
        :open="isMobileActionsOpen"
        :content="{
          side: 'bottom',
          align: 'end',
          sideOffset: 8,
          collisionPadding: 12,
        }"
        :modal="false"
        class="sm:hidden"
        :ui="{
          content:
            'w-52 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl shadow-foreground/10 dark:shadow-foreground/10',
        }"
        @update:open="isMobileActionsOpen = $event"
      >
        <UButton
          type="button"
          color="neutral"
          variant="ghost"
          icon="i-lucide-more-vertical"
          size="sm"
          aria-label="Open header actions"
          class="text-foreground hover:bg-accent hover:text-accent-foreground"
        />

        <template #content>
          <div class="space-y-1">
            <button
              type="button"
              class="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
              @click="toggleAutoStickToBottom"
            >
              <UIcon name="i-lucide-arrow-down-to-line" class="size-4" />
              <span class="flex-1">Stick to bottom</span>
              <UIcon
                v-if="autoStickToBottom"
                name="i-lucide-check"
                class="size-4"
              />
            </button>

            <button
              type="button"
              class="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
              @click="handleMobileThemeToggle"
            >
              <UIcon
                :name="isDark ? 'i-lucide-sun' : 'i-lucide-moon'"
                class="size-4"
              />
              <span>{{ isDark ? "Light mode" : "Dark mode" }}</span>
            </button>

            <button
              type="button"
              class="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
              @click="handleMobileLogout"
            >
              <UIcon name="i-lucide-log-out" class="size-4" />
              <span>Log out</span>
            </button>
          </div>
        </template>
      </UPopover>
    </div>
  </header>
</template>
