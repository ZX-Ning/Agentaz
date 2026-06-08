<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import type { ThinkingLevel } from "../../types/protocol";

type ModelOption = {
  value: string;
  label: string;
  description: string;
};

type ThinkingOption = {
  value: ThinkingLevel;
  label: string;
};

const props = defineProps<{
  promptText: string;
  isStreaming: boolean;
  isSubmitting: boolean;
  isConnected: boolean;
  isDraftSession: boolean;
  modelOptions: ModelOption[];
  selectedModelKey: string;
  currentThinkingLevel: ThinkingLevel;
  visibleThinkingOptions: ThinkingOption[];
  pendingModelChange: boolean;
  pendingThinkingChange: boolean;
}>();

const emit = defineEmits<{
  (event: "update:promptText", value: string): void;
  (event: "model-select" | "thinking-select", value: unknown): void;
  (event: "submit"): void;
}>();

const textareaRef = ref<HTMLTextAreaElement | null>(null);
const composerHeight = ref<number | null>(null);
const isResizing = ref(false);
const isModelMenuOpen = ref(false);
const modelSearch = ref("");
const dragStartY = ref(0);
const dragStartHeight = ref(0);
const minHeight = 48;
const maxHeight = 224;
const maxVisibleModels = 50;

const selectedModelLabel = computed(() => {
  const selectedLabel = props.modelOptions.find(
    (option) => option.value === props.selectedModelKey,
  )?.label;
  if (selectedLabel) return selectedLabel;
  if (props.isDraftSession) return "Default model";
  return "Model loading...";
});

const filteredModelOptions = computed(() => {
  const query = modelSearch.value.trim().toLowerCase();
  if (!query) return props.modelOptions;

  return props.modelOptions.filter((option) => {
    return (
      option.label.toLowerCase().includes(query) ||
      option.description.toLowerCase().includes(query)
    );
  });
});

const visibleModelOptions = computed(() =>
  filteredModelOptions.value.slice(0, maxVisibleModels),
);
const hiddenModelCount = computed(() =>
  Math.max(
    0,
    filteredModelOptions.value.length - visibleModelOptions.value.length,
  ),
);
const shouldBlockSubmit = computed(
  () => props.isSubmitting && !props.isStreaming,
);

function onPromptInput(event: Event) {
  emit("update:promptText", (event.target as HTMLTextAreaElement).value);
}

function onComposerKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    if (shouldBlockSubmit.value) return;
    emit("submit");
  }
}

function submitComposer() {
  if (shouldBlockSubmit.value) return;
  emit("submit");
}

function onTopResizeStart(event: MouseEvent) {
  if (!textareaRef.value) return;
  isResizing.value = true;
  dragStartY.value = event.clientY;
  dragStartHeight.value = textareaRef.value.offsetHeight;
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", onTopResizeMove);
  window.addEventListener("mouseup", onTopResizeEnd);
}

function onTopResizeMove(event: MouseEvent) {
  if (!isResizing.value) return;
  const deltaY = event.clientY - dragStartY.value;
  const next = dragStartHeight.value - deltaY;
  composerHeight.value = Math.max(minHeight, Math.min(maxHeight, next));
}

function onTopResizeEnd() {
  isResizing.value = false;
  document.body.style.userSelect = "";
  window.removeEventListener("mousemove", onTopResizeMove);
  window.removeEventListener("mouseup", onTopResizeEnd);
}

function syncHeightFromTextarea() {
  if (!textareaRef.value) return;
  composerHeight.value = Math.max(
    minHeight,
    Math.min(maxHeight, textareaRef.value.offsetHeight),
  );
}

function onModelMenuOpenChange(open: boolean) {
  isModelMenuOpen.value = open;
  if (open) modelSearch.value = "";
}

function selectModel(value: string) {
  emit("model-select", value);
  isModelMenuOpen.value = false;
}

onBeforeUnmount(() => {
  onTopResizeEnd();
});
</script>

<template>
  <form
    class="mx-auto flex w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-input bg-card/95 text-card-foreground shadow-lg shadow-foreground/10 backdrop-blur dark:shadow-foreground/10 sm:shadow-xl"
    @submit.prevent="submitComposer"
  >
    <div
      class="hidden h-2 w-full cursor-ns-resize border-b border-border/60 hover:bg-accent/40 sm:block"
      @mousedown.prevent="onTopResizeStart"
    />

    <textarea
      ref="textareaRef"
      :value="props.promptText"
      :disabled="props.isSubmitting"
      rows="1"
      :style="{ height: composerHeight ? `${composerHeight}px` : undefined }"
      class="max-h-32 min-h-10 resize-y bg-transparent px-3 py-2 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/35 sm:max-h-56 sm:min-h-12 sm:px-4 sm:py-3"
      placeholder="Message Agentaz"
      @input="onPromptInput"
      @keydown="onComposerKeydown"
      @mouseup="syncHeightFromTextarea"
    />

    <div
      class="flex min-h-10 items-center justify-between gap-1.5 border-t border-border px-2 py-1 sm:min-h-11 sm:gap-2 sm:px-2.5 sm:py-1.5"
    >
      <div class="flex min-w-0 flex-1 items-center gap-1">
        <UPopover
          :open="isModelMenuOpen"
          :content="{
            side: 'top',
            align: 'start',
            sideOffset: 8,
            collisionPadding: 12,
          }"
          :modal="false"
          class="min-w-0 flex-1 sm:flex-[1_1_16rem] sm:max-w-96"
          :ui="{
            content:
              'w-[min(30rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl shadow-foreground/10 dark:shadow-foreground/10',
          }"
          @update:open="onModelMenuOpenChange"
        >
          <template #content>
            <div class="border-b border-border p-2">
              <UInput
                v-model="modelSearch"
                placeholder="Search models..."
                variant="none"
                size="sm"
                class="text-xs font-normal"
                @click.stop
                @keydown.stop
              />
            </div>

            <div class="max-h-80 overflow-y-auto p-1">
              <button
                v-for="option in visibleModelOptions"
                :key="option.value"
                type="button"
                class="flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-normal text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
                @click="selectModel(option.value)"
              >
                <UIcon
                  name="i-lucide-check"
                  class="size-4 shrink-0 text-primary"
                  :class="{
                    'opacity-0': option.value !== props.selectedModelKey,
                  }"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs font-normal">{{
                    option.label
                  }}</span>
                  <span
                    class="block truncate text-[11px] font-normal text-muted-foreground"
                  >
                    {{ option.description }}
                  </span>
                </span>
              </button>

              <div
                v-if="hiddenModelCount > 0"
                class="px-3 py-2 text-xs font-normal text-muted-foreground"
              >
                {{ hiddenModelCount }} more. Type to narrow results.
              </div>

              <div
                v-if="visibleModelOptions.length === 0"
                class="px-3 py-6 text-center text-xs font-normal text-muted-foreground"
              >
                No matching models.
              </div>
            </div>
          </template>

          <UButton
            type="button"
            color="neutral"
            variant="ghost"
            trailing-icon="i-lucide-chevron-down"
            :disabled="
              props.modelOptions.length === 0 ||
              !props.isConnected ||
              props.isSubmitting
            "
            class="w-full min-w-0 justify-start bg-transparent px-2 py-1 text-xs font-normal text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
            :ui="{ label: 'min-w-0 truncate whitespace-nowrap font-normal' }"
          >
            {{ selectedModelLabel }}
          </UButton>
        </UPopover>

        <USelect
          :model-value="props.currentThinkingLevel"
          :items="props.visibleThinkingOptions"
          value-key="value"
          label-key="label"
          :disabled="
            props.visibleThinkingOptions.length === 0 ||
            !props.isConnected ||
            props.isSubmitting
          "
          color="neutral"
          variant="ghost"
          size="sm"
          class="w-20 shrink-0 text-xs font-normal text-foreground sm:w-28"
          :ui="{
            base: 'bg-transparent text-xs font-normal text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/35 disabled:opacity-60',
            content: 'bg-popover text-popover-foreground border-border',
            item: 'text-xs font-normal text-foreground hover:bg-accent hover:text-accent-foreground data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground',
          }"
          @update:model-value="emit('thinking-select', $event)"
        />

        <span
          v-if="props.pendingModelChange || props.pendingThinkingChange"
          class="hidden rounded-lg border border-border bg-secondary px-2 py-1 text-xs text-secondary-foreground sm:inline-flex"
        >
          Pending after current turn
        </span>
      </div>

      <UButton
        type="submit"
        :icon="props.isStreaming ? 'i-lucide-square' : 'i-lucide-send'"
        :loading="props.isSubmitting && !props.isStreaming"
        size="sm"
        :aria-label="props.isStreaming ? 'Stop streaming' : 'Send message'"
        :disabled="
          (props.isSubmitting && !props.isStreaming) ||
          (!props.isStreaming && !props.promptText.trim())
        "
        class="shrink-0 bg-primary px-2.5 py-1.5 text-xs font-normal text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        <span class="hidden sm:inline">{{
          props.isStreaming ? "Stop" : "Send"
        }}</span>
      </UButton>
    </div>
  </form>
</template>
