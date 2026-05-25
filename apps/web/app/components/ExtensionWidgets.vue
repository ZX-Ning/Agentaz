<script setup lang="ts">
import type { UiExtensionWidget } from "../../types/protocol";

defineProps<{
  widgets: UiExtensionWidget[];
}>();
</script>

<template>
  <section
    v-if="widgets.length"
    class="space-y-3 rounded-lg border border-border bg-card p-3 text-card-foreground"
  >
    <div
      v-for="widget in widgets"
      :key="widget.key"
      class="font-mono text-xs leading-5 whitespace-pre-wrap text-muted-foreground"
    >
      <div v-for="(line, index) in widget.lines" :key="index">
        {{ line }}
      </div>
    </div>
  </section>
</template>
