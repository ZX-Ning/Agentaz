<script setup lang="ts">
import { cn } from "../../../lib/utils";

defineOptions({ inheritAttrs: false });

const model = defineModel<string | number>();
const props = defineProps<{
    class?: unknown;
}>();
</script>

<template>
  <input
    v-model="model"
    v-bind="$attrs"
    :class="cn(
      'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50',
      props.class,
    )"
  />
</template>
