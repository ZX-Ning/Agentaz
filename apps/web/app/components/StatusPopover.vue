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
  canControlActiveSession: boolean;
}>();

const emit = defineEmits<{
  (event: "update:isOpen", value: boolean): void;
  (event: "acquire"): void;
  (event: "release"): void;
  (event: "clearQueue"): void;
  (event: "closeSession"): void;
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
        'w-72 overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl shadow-foreground/10 dark:shadow-black/30',
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
          <div
            class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2"
          >
            Session Control
          </div>

          <div class="grid grid-cols-2 gap-2">
            <UButton
              color="neutral"
              variant="soft"
              size="sm"
              icon="i-lucide-lock"
              :disabled="!canControlActiveSession"
              class="justify-center"
              @click="emit('acquire')"
            >
              Acquire
            </UButton>
            <UButton
              color="neutral"
              variant="soft"
              size="sm"
              icon="i-lucide-unlock"
              :disabled="!canControlActiveSession"
              class="justify-center"
              @click="emit('release')"
            >
              Release
            </UButton>
          </div>

          <div class="grid grid-cols-2 gap-2">
            <UButton
              color="neutral"
              variant="soft"
              size="sm"
              icon="i-lucide-trash-2"
              :disabled="!canControlActiveSession"
              class="justify-center"
              @click="emit('clearQueue')"
            >
              Clear Queue
            </UButton>
            <UButton
              color="error"
              variant="soft"
              size="sm"
              icon="i-lucide-x-circle"
              class="justify-center"
              @click="emit('closeSession')"
            >
              Close
            </UButton>
          </div>
        </div>
      </div>
    </template>

    <UButton
      type="button"
      color="neutral"
      variant="outline"
      size="sm"
      class="flex items-center gap-2"
    >
      <span class="relative flex h-2 w-2">
        <span
          v-if="status === 'connected' && isStreaming"
          class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
          :class="status === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'"
        ></span>
        <span
          class="relative inline-flex rounded-full h-2 w-2"
          :class="{
            'bg-emerald-500': status === 'connected',
            'bg-amber-500': status === 'connecting',
            'bg-rose-500': status === 'error',
            'bg-slate-500': status === 'disconnected',
          }"
        ></span>
      </span>

      <span class="text-xs font-medium">{{ statusLabel }}</span>
      <UIcon name="i-lucide-chevron-down" class="size-4 shrink-0 opacity-60" />
    </UButton>
  </UPopover>
</template>
