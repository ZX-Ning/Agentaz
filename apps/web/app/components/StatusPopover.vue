<script setup lang="ts">
import type { UiLoadedSession } from "../../types/protocol";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

defineProps<{
  isOpen: boolean;
  status: ConnectionStatus;
  isStreaming: boolean;
  statusColor: "success" | "warning" | "error" | "neutral";
  statusLabel: string;
  pendingMessageCount: number;
  pendingApprovalCount: number;
  modelsCount: number;
  activeLoadedSession: UiLoadedSession | null;
}>();

const emit = defineEmits<{
  (event: "update:isOpen", value: boolean): void;
  (event: "clearQueue"): void;
}>();
</script>

<template>
  <UPopover
    :open="isOpen"
    :content="{
      side: 'bottom',
      align: 'end',
      sideOffset: 8,
      collisionPadding: 12,
    }"
    :modal="false"
    class="shrink-0"
    :ui="{
      content:
        'w-72 overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl shadow-foreground/10 dark:shadow-foreground/10',
    }"
    @update:open="emit('update:isOpen', $event)"
  >
    <template #content>
      <div class="p-4 space-y-4 text-left">
        <div
          class="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          System Status
        </div>

        <div class="space-y-2.5">
          <div class="flex items-center justify-between text-sm">
            <span class="text-muted-foreground flex items-center gap-1.5">
              <UIcon
                name="i-lucide-activity"
                class="size-4 text-muted-foreground"
              />
              Connection
            </span>
            <UBadge :color="statusColor" variant="soft" size="xs">{{
              statusLabel
            }}</UBadge>
          </div>

          <div class="flex items-center justify-between text-sm">
            <span class="text-muted-foreground flex items-center gap-1.5">
              <UIcon
                name="i-lucide-layers"
                class="size-4 text-muted-foreground"
              />
              Queue
            </span>
            <span
              class="font-medium bg-secondary px-1.5 py-0.5 rounded text-xs text-secondary-foreground font-sans"
              >{{ pendingMessageCount }} messages</span
            >
          </div>

          <div class="flex items-center justify-between text-sm">
            <span class="text-muted-foreground flex items-center gap-1.5">
              <UIcon
                name="i-lucide-shield-alert"
                class="size-4 text-muted-foreground"
              />
              Approvals
            </span>
            <UBadge
              v-if="pendingApprovalCount > 0"
              color="warning"
              variant="solid"
              size="xs"
            >
              {{ pendingApprovalCount }} pending
            </UBadge>
            <span v-else class="font-medium text-xs text-muted-foreground"
              >0 pending</span
            >
          </div>

          <div class="flex items-center justify-between text-sm">
            <span class="text-muted-foreground flex items-center gap-1.5">
              <UIcon name="i-lucide-cpu" class="size-4 text-muted-foreground" />
              Available Models
            </span>
            <span class="font-medium text-xs text-muted-foreground font-sans"
              >{{ modelsCount }} models</span
            >
          </div>
        </div>

        <div
          v-if="activeLoadedSession"
          class="pt-3 border-t border-border space-y-2"
        >
          <div>
            <UButton
              color="neutral"
              variant="soft"
              size="sm"
              icon="i-lucide-trash-2"
              :disabled="!activeLoadedSession"
              class="w-full justify-center"
              @click="emit('clearQueue')"
            >
              Clear Queue
            </UButton>
          </div>
        </div>
      </div>
    </template>

    <UButton
      type="button"
      color="neutral"
      variant="ghost"
      icon="i-lucide-activity"
      size="sm"
      aria-label="Open system status"
      class="hidden text-foreground hover:bg-accent hover:text-accent-foreground sm:inline-flex"
    />
  </UPopover>
</template>
