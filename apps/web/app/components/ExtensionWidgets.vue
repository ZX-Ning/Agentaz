<script setup lang="ts">
import type { UiExtensionWidget } from "../../types/protocol";

const props = defineProps<{
  widgets: UiExtensionWidget[];
}>();

const isOpen = ref(false);

const lineCount = computed(() =>
  props.widgets.reduce((count, widget) => count + widget.lines.length, 0),
);
const title = computed(() =>
  props.widgets.some((widget) => widget.key.toLowerCase().includes("todo"))
    ? "Todo"
    : "Extension output",
);
</script>

<template>
  <section
    v-if="widgets.length"
    class="overflow-hidden rounded-lg border border-border bg-card text-card-foreground"
  >
    <button
      type="button"
      class="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-accent"
      @click="isOpen = !isOpen"
    >
      <span class="flex min-w-0 items-center gap-2">
        <UIcon
          name="i-lucide-list-checks"
          class="size-4 shrink-0 text-muted-foreground"
        />
        <span class="truncate text-sm font-medium">{{ title }}</span>
      </span>
      <span class="flex shrink-0 items-center gap-2">
        <UBadge color="neutral" variant="soft" size="xs">
          {{ lineCount }}
        </UBadge>
        <UIcon
          :name="isOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="size-4 text-muted-foreground"
        />
      </span>
    </button>

    <div v-if="isOpen" class="space-y-3 border-t border-border px-3 py-3">
      <div
        v-for="widget in widgets"
        :key="widget.key"
        class="font-mono text-xs leading-5 whitespace-pre-wrap text-muted-foreground"
      >
        <div v-for="(line, index) in widget.lines" :key="index">
          {{ line }}
        </div>
      </div>
    </div>
  </section>
</template>
