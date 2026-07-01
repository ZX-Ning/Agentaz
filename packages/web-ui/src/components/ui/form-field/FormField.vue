<script setup lang="ts">
defineProps<{ label?: string }>();
</script>

<template>
  <label class="grid gap-2 text-sm font-medium text-foreground">
    <span v-if="label">{{ label }}</span>
    <slot />
  </label>
</template>
