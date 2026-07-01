<script setup lang="ts">
import { computed } from "vue";
import {
  PopoverArrow,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
} from "reka-ui";

const props = withDefaults(
  defineProps<{
    open?: boolean;
    content?: {
      side?: "top" | "right" | "bottom" | "left";
      align?: "start" | "center" | "end";
      sideOffset?: number;
      collisionPadding?: number;
    };
    ui?: { content?: unknown };
    modal?: boolean;
    side?: "top" | "right" | "bottom" | "left";
    align?: "start" | "center" | "end";
    sideOffset?: number;
    collisionPadding?: number;
    contentClass?: unknown;
    class?: unknown;
  }>(),
  {
    side: "bottom",
    align: "center",
    sideOffset: 8,
    collisionPadding: 12,
  },
);

const emit = defineEmits<{
  (event: "update:open", value: boolean): void;
}>();

const resolvedSide = computed(() => props.content?.side ?? props.side);
const resolvedAlign = computed(() => props.content?.align ?? props.align);
const resolvedSideOffset = computed(() =>
  props.content?.sideOffset ?? props.sideOffset
);
const resolvedCollisionPadding = computed(() =>
  props.content?.collisionPadding ?? props.collisionPadding
);
</script>

<template>
  <PopoverRoot :open="open" @update:open="emit('update:open', $event)">
    <PopoverTrigger as-child>
      <div :class="props.class">
        <slot />
      </div>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent :side="resolvedSide" :align="resolvedAlign"
        :side-offset="resolvedSideOffset"
        :collision-padding="resolvedCollisionPadding" :class="[
          'z-50 overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl shadow-foreground/10 outline-none dark:shadow-foreground/10',
          ui?.content,
          contentClass,
        ]">
        <slot name="content" />
        <PopoverArrow class="fill-border" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
