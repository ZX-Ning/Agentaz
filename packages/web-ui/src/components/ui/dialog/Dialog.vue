<script setup lang="ts">
import {
    DialogClose,
    DialogContent,
    DialogOverlay,
    DialogPortal,
    DialogRoot,
    DialogTitle,
} from "reka-ui";
import { X } from "lucide-vue-next";
import { cn } from "../../../lib/utils";

const props = defineProps<{
    open?: boolean;
        title?: string;
        ui?: { content?: unknown };
        contentClass?: unknown;
}>();

const emit = defineEmits<{
    (event: "update:open", value: boolean): void;
}>();
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <slot />
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-foreground/20 backdrop-blur-sm" />
      <DialogContent
        :class="cn(
          'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-xl outline-none',
          ui?.content,
          contentClass,
        )"
      >
        <DialogTitle v-if="title" class="text-base font-semibold">
          {{ title }}
        </DialogTitle>
        <slot name="body" />
        <slot name="content" />
        <DialogClose
          class="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
          aria-label="Close"
        >
          <X class="size-4" />
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
