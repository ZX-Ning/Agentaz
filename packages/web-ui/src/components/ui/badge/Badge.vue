<script setup lang="ts">
import { computed } from "vue";
import { cn } from "../../../lib/utils";

const props = withDefaults(
    defineProps<{
        variant?: "default" | "secondary" | "destructive" | "outline" | "soft" | "solid";
        color?: "primary" | "neutral" | "error" | "warning" | "success";
        size?: "xs" | "sm";
        class?: unknown;
    }>(),
    {
        variant: "default",
        color: "primary",
        size: "sm",
    },
);

const colorClass = computed(() => {
    if (props.color === "error") return "bg-destructive text-white";
    if (props.color === "warning") return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    if (props.color === "success") return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    if (props.color === "neutral") return "bg-secondary text-secondary-foreground";
    return "bg-primary text-primary-foreground";
});
</script>

<template>
  <span
    :class="cn(
      'inline-flex items-center rounded-md border border-transparent font-medium whitespace-nowrap',
      props.size === 'xs' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs',
      props.variant === 'outline' ? 'border-border bg-transparent text-foreground' : colorClass,
      props.class,
    )"
  >
    <slot />
  </span>
</template>
