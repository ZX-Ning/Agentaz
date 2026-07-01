<script setup lang="ts">
import { computed } from "vue";
import type { HTMLAttributes } from "vue";
import { LoaderCircle } from "lucide-vue-next";
import AppIcon from "../AppIcon.vue";

const props = withDefaults(
  defineProps<{
    type?: "button" | "submit" | "reset";
    variant?:
      | "default"
      | "destructive"
      | "outline"
      | "secondary"
      | "ghost"
      | "link"
      | "soft";
    color?: "primary" | "neutral" | "error" | "warning" | "success";
    size?: "default" | "sm" | "xs" | "lg" | "icon";
    block?: boolean;
    loading?: boolean;
    disabled?: boolean;
    icon?: string;
    trailingIcon?: string;
    class?: HTMLAttributes["class"];
  }>(),
  {
    type: "button",
    variant: "default",
    color: "primary",
    size: "default",
  },
);

const variantClass = computed(() => {
  if (props.color === "error") {
    return "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/30";
  }
  if (props.variant === "ghost") {
    return "hover:bg-accent hover:text-accent-foreground";
  }
  if (props.variant === "outline") {
    return "border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground";
  }
  if (props.variant === "secondary" || props.variant === "soft") {
    return "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80";
  }
  if (props.variant === "link") {
    return "text-primary underline-offset-4 hover:underline";
  }
  return "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90";
});

const sizeClass = computed(() => {
  if (props.size === "xs") {
    return "h-7 gap-1.5 px-2 text-xs";
  }
  if (props.size === "sm") {
    return "h-8 gap-1.5 px-3 text-sm";
  }
  if (props.size === "lg") {
    return "h-10 px-6";
  }
  if (props.size === "icon") {
    return "size-9 p-0";
  }
  return "h-9 px-4 py-2";
});
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    :class="[
      'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
      variantClass,
      sizeClass,
      block && 'w-full',
      props.class,
    ]"
  >
    <AppIcon v-if="icon && !loading" :name="icon" class="size-4" />
    <LoaderCircle v-if="loading" class="mr-2 size-4 animate-spin" />
    <slot />
    <AppIcon v-if="trailingIcon" :name="trailingIcon" class="size-4" />
  </button>
</template>
