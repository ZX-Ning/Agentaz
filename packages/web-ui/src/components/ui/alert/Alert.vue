<script setup lang="ts">
import { cn } from "../../../lib/utils";

const props = withDefaults(
    defineProps<{
        title?: string;
        description?: string | null;
        color?: "error" | "warning" | "success" | "primary" | "neutral";
        class?: unknown;
    }>(),
    {
        color: "neutral",
    },
);
</script>

<template>
  <div
    :class="cn(
      'rounded-lg border p-3 text-sm',
      color === 'error' ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-border bg-card text-card-foreground',
      props.class,
    )"
  >
    <div v-if="title" class="font-medium">{{ title }}</div>
    <div v-if="description" class="mt-1 text-xs opacity-90">{{ description }}</div>
    <slot />
  </div>
</template>
