<script setup lang="ts">
import {
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuPortal,
    ContextMenuRoot,
    ContextMenuTrigger,
} from "reka-ui";
import AppIcon from "../AppIcon.vue";

type MenuItem = {
    label: string;
    icon?: string;
    disabled?: boolean;
    color?: "error";
    onSelect?: () => void;
};

defineProps<{
    items: MenuItem[][];
}>();
</script>

<template>
  <ContextMenuRoot>
    <ContextMenuTrigger as-child>
      <slot />
    </ContextMenuTrigger>
    <ContextMenuPortal>
      <ContextMenuContent
        class="z-50 min-w-40 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
      >
        <template v-for="(group, groupIndex) in items" :key="groupIndex">
          <div v-if="groupIndex > 0" class="my-1 h-px bg-border" />
          <ContextMenuItem
            v-for="item in group"
            :key="item.label"
            :disabled="item.disabled"
            class="flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
            :class="item.color === 'error' ? 'text-destructive' : ''"
            @select="item.onSelect?.()"
          >
            <AppIcon v-if="item.icon" :name="item.icon" class="size-4" />
            {{ item.label }}
          </ContextMenuItem>
        </template>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>
