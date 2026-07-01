<script setup lang="ts">
import type { UiLoadedSession } from "@agentaz/protocol";

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
  <Popover
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
              <AppIcon
                name="i-lucide-activity"
                class="size-4 text-muted-foreground"
              />
              Connection
            </span>
            <span
              :class="[
                'inline-flex items-center rounded-md border border-transparent px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
                statusColor === 'success'
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                  : statusColor === 'warning'
                    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                    : statusColor === 'error'
                      ? 'bg-destructive text-white'
                      : 'bg-secondary text-secondary-foreground',
              ]"
            >{{ statusLabel }}</span>
          </div>

          <div class="flex items-center justify-between text-sm">
            <span class="text-muted-foreground flex items-center gap-1.5">
              <AppIcon
                name="i-lucide-layers"
                class="size-4 text-muted-foreground"
              />
              Queue
            </span>
            <span
              class="font-medium bg-secondary px-1.5 py-0.5 rounded text-xs text-secondary-foreground font-sans"
            >{{ pendingMessageCount }} messages</span>
          </div>

          <div class="flex items-center justify-between text-sm">
            <span class="text-muted-foreground flex items-center gap-1.5">
              <AppIcon
                name="i-lucide-shield-alert"
                class="size-4 text-muted-foreground"
              />
              Approvals
            </span>
            <span
              v-if="pendingApprovalCount > 0"
              class="inline-flex items-center rounded-md border border-transparent bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-amber-700 dark:text-amber-300"
            >
              {{ pendingApprovalCount }} pending
            </span>
            <span v-else class="font-medium text-xs text-muted-foreground"
            >0 pending</span>
          </div>

          <div class="flex items-center justify-between text-sm">
            <span class="text-muted-foreground flex items-center gap-1.5">
              <AppIcon name="i-lucide-cpu" class="size-4 text-muted-foreground" />
              Available Models
            </span>
            <span class="font-medium text-xs text-muted-foreground font-sans"
            >{{ modelsCount }} models</span>
          </div>
        </div>

        <div
          v-if="activeLoadedSession"
          class="pt-3 border-t border-border space-y-2"
        >
          <div>
            <Button
              color="neutral"
              variant="soft"
              size="sm"
              icon="i-lucide-trash-2"
              :disabled="!activeLoadedSession"
              class="w-full justify-center"
              @click="emit('clearQueue')"
            >
              Clear Queue
            </Button>
          </div>
        </div>
      </div>
    </template>

    <Button
      type="button"
      color="neutral"
      variant="ghost"
      icon="i-lucide-activity"
      size="sm"
      aria-label="Open system status"
      class="hidden text-foreground hover:bg-accent hover:text-accent-foreground sm:inline-flex"
    />
  </Popover>
</template>
