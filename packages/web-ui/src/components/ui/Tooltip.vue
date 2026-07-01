<script setup lang="ts">
import {
    TooltipContent,
    TooltipPortal,
    TooltipProvider,
    TooltipRoot,
    TooltipTrigger,
} from "reka-ui";

withDefaults(
    defineProps<{
        text: string;
    }>(),
    {},
);
</script>

<template>
  <TooltipProvider>
    <TooltipRoot>
      <TooltipTrigger as-child>
        <slot />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          class="z-50 rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          :side-offset="6"
        >
          {{ text }}
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
