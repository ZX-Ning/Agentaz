<script setup lang="ts">
import { Check, ChevronDown } from "lucide-vue-next";
import {
    SelectContent,
    SelectItem,
    SelectItemIndicator,
    SelectItemText,
    SelectPortal,
    SelectRoot,
    SelectTrigger,
    SelectValue,
    SelectViewport,
} from "reka-ui";

type Option = {
    label: string;
    value: string;
};

defineProps<{
    items: Option[];
    disabled?: boolean;
    valueKey?: string;
    labelKey?: string;
}>();

const model = defineModel<string>();
</script>

<template>
  <SelectRoot v-model="model" :disabled="disabled">
    <SelectTrigger
      class="inline-flex h-8 min-w-28 items-center justify-between gap-2 rounded-md px-2 text-xs text-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <SelectValue />
      <ChevronDown class="size-3.5 opacity-70" />
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        class="z-50 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
        :side-offset="6"
      >
        <SelectViewport class="p-1">
          <SelectItem
            v-for="item in items"
            :key="item.value"
            :value="item.value"
            class="relative flex h-8 cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2 text-xs outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
          >
            <SelectItemIndicator class="absolute left-2 inline-flex items-center">
              <Check class="size-3.5" />
            </SelectItemIndicator>
            <SelectItemText>{{ item.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
