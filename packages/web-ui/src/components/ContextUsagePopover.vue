<script setup lang="ts">
import { computed } from "vue";
import type { UiLoadedSession } from "@agentaz/protocol";

const props = defineProps<{
  isOpen: boolean;
  activeLoadedSession: UiLoadedSession | null;
  isCompactDisabled: boolean;
  isCompacting: boolean;
}>();

const emit = defineEmits<{
  (event: "update:isOpen", value: boolean): void;
  (event: "compact"): void;
}>();

const contextUsage = computed(() => props.activeLoadedSession?.contextUsage);
const usageStats = computed(() => props.activeLoadedSession?.usageStats);

const contextPercentLabel = computed(() =>
  contextUsage.value?.percent === null ||
  contextUsage.value?.percent === undefined
    ? "--%"
    : `${Math.round(contextUsage.value.percent)}%`,
);

const contextButtonLabel = computed(
  () => `Context ${contextPercentLabel.value}`,
);

function formatTokens(value?: number | null) {
  if (value === null || value === undefined) return "--";
  return value.toLocaleString();
}

function formatPercent(value?: number | null) {
  if (value === null || value === undefined) return "Unavailable";
  return `${Math.round(value)}%`;
}

function formatContextTokenWindow() {
  const usage = contextUsage.value;
  if (!usage || usage.tokens === null) return "-- tokens";
  return `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}`;
}

function formatCost(value?: number | null) {
  if (value === null || value === undefined) return "$0.0000";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value);
}
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
        'w-80 overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl shadow-foreground/10 dark:shadow-foreground/10',
    }"
    @update:open="emit('update:isOpen', $event)"
  >
    <template #content>
      <div class="space-y-4 p-4 text-left">
        <div
          class="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Context
        </div>

        <div class="space-y-2.5">
          <div class="flex items-center justify-between text-sm">
            <span class="flex items-center gap-1.5 text-muted-foreground">
              <AppIcon
                name="i-lucide-gauge"
                class="size-4 text-muted-foreground"
              />
              Window usage
            </span>
            <span class="font-medium text-xs text-muted-foreground font-sans">
              {{ formatPercent(contextUsage?.percent) }}
            </span>
          </div>

          <div class="flex items-center justify-between text-sm">
            <span class="flex items-center gap-1.5 text-muted-foreground">
              <AppIcon
                name="i-lucide-braces"
                class="size-4 text-muted-foreground"
              />
              Context tokens
            </span>
            <span class="font-medium text-xs text-muted-foreground font-sans">
              {{ formatContextTokenWindow() }}
            </span>
          </div>
        </div>

        <div class="space-y-2 border-t border-border pt-3">
          <div
            class="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Token Usage
          </div>

          <template v-if="usageStats">
            <div class="grid grid-cols-2 gap-2 text-xs">
              <div class="rounded-md bg-secondary px-2 py-1.5">
                <div class="text-muted-foreground">Input</div>
                <div class="font-medium text-secondary-foreground font-sans">
                  {{ formatTokens(usageStats.tokens.input) }}
                </div>
              </div>
              <div class="rounded-md bg-secondary px-2 py-1.5">
                <div class="text-muted-foreground">Output</div>
                <div class="font-medium text-secondary-foreground font-sans">
                  {{ formatTokens(usageStats.tokens.output) }}
                </div>
              </div>
              <div class="rounded-md bg-secondary px-2 py-1.5">
                <div class="text-muted-foreground">Cache read</div>
                <div class="font-medium text-secondary-foreground font-sans">
                  {{ formatTokens(usageStats.tokens.cacheRead) }}
                </div>
              </div>
              <div class="rounded-md bg-secondary px-2 py-1.5">
                <div class="text-muted-foreground">Cache write</div>
                <div class="font-medium text-secondary-foreground font-sans">
                  {{ formatTokens(usageStats.tokens.cacheWrite) }}
                </div>
              </div>
            </div>

            <div class="space-y-2.5">
              <div class="flex items-center justify-between text-sm">
                <span class="text-muted-foreground">Total tokens</span>
                <span
                  class="font-medium text-xs text-muted-foreground font-sans"
                >
                  {{ formatTokens(usageStats.tokens.total) }}
                </span>
              </div>
              <div class="flex items-center justify-between text-sm">
                <span class="text-muted-foreground">Messages</span>
                <span
                  class="font-medium text-xs text-muted-foreground font-sans"
                >
                  {{ formatTokens(usageStats.totalMessages) }}
                </span>
              </div>
              <div class="flex items-center justify-between text-sm">
                <span class="text-muted-foreground">Tool calls</span>
                <span
                  class="font-medium text-xs text-muted-foreground font-sans"
                >
                  {{ formatTokens(usageStats.toolCalls) }}
                </span>
              </div>
              <div class="flex items-center justify-between text-sm">
                <span class="text-muted-foreground">Cost</span>
                <span
                  class="font-medium text-xs text-muted-foreground font-sans"
                >
                  {{ formatCost(usageStats.cost) }}
                </span>
              </div>
            </div>
          </template>

          <div v-else class="text-sm text-muted-foreground">No usage yet</div>
        </div>

        <div class="border-t border-border pt-3">
          <Button
            color="neutral"
            variant="soft"
            size="sm"
            icon="i-lucide-file-stack"
            :loading="isCompacting"
            :disabled="isCompactDisabled"
            class="w-full justify-center"
            @click="emit('compact')"
          >
            Compact
          </Button>
        </div>
      </div>
    </template>

    <Button
      type="button"
      color="neutral"
      variant="outline"
      size="sm"
      icon="i-lucide-gauge"
      class="flex items-center gap-1 px-2 sm:gap-2 sm:px-3"
    >
      <span class="text-xs font-medium">{{ contextButtonLabel }}</span>
      <AppIcon
        name="i-lucide-chevron-down"
        class="size-3.5 shrink-0 opacity-60 sm:size-4"
      />
    </Button>
  </Popover>
</template>
