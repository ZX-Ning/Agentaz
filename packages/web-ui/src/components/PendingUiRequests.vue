<script setup lang="ts">
import type { PendingUiRequest } from "@agentaz/protocol";

defineProps<{
  requests: PendingUiRequest[];
}>();

const emit = defineEmits<{
  (event: "respond", request: PendingUiRequest, value?: string | boolean): void;
}>();

const messagePreviewLimit = 1200;

/** Keeps approval prompts readable when a tool asks to run a very long command. */
function messagePreview(message: string) {
  if (message.length <= messagePreviewLimit) {
    return message;
  }
  return `${message.slice(0, messagePreviewLimit)}\n... truncated ${
    message.length - messagePreviewLimit
  } characters`;
}

function isLongMessage(message: string) {
  return message.length > messagePreviewLimit;
}
</script>

<template>
  <section
    v-if="requests.length"
    class="space-y-3 rounded-lg border border-border bg-card p-4"
  >
    <div class="text-sm font-semibold text-card-foreground">
      Pending UI requests
    </div>
    <div
      v-for="request in requests"
      :key="request.requestId"
      class="space-y-2 rounded-lg border border-border p-3 text-sm"
    >
      <div class="font-medium">{{ request.title }}</div>
      <div
        v-if="request.type === 'ui_confirm_request' && request.message"
        class="max-h-48 overflow-auto rounded-md border border-border bg-muted/50 p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words text-muted-foreground"
      >
        {{ messagePreview(request.message) }}
      </div>
      <details
        v-if="request.type === 'ui_confirm_request' && isLongMessage(request.message)"
        class="text-xs text-muted-foreground"
      >
        <summary class="cursor-pointer select-none text-card-foreground">
          Show full request
        </summary>
        <pre
          class="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-muted/50 p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words text-muted-foreground"
        >{{ request.message }}</pre>
      </details>
      <p
        v-if="request.type === 'ui_input_request' && request.placeholder"
        class="text-xs text-muted-foreground"
      >
        {{ request.placeholder }}
      </p>
      <div class="text-xs text-muted-foreground">
        {{ request.type }} · {{ request.requestId }}
      </div>
      <div
        v-if="request.type === 'ui_select_request'"
        class="flex flex-wrap gap-2"
      >
        <Button
          v-for="option in request.options"
          :key="option"
          size="xs"
          color="neutral"
          variant="soft"
          @click="emit('respond', request, option)"
        >
          {{ option }}
        </Button>
        <Button
          size="xs"
          color="error"
          variant="soft"
          @click="emit('respond', request)"
        >Cancel</Button>
      </div>
      <div v-else-if="request.type === 'ui_confirm_request'" class="flex gap-2">
        <Button
          size="xs"
          color="primary"
          @click="emit('respond', request, true)"
        >Confirm</Button>
        <Button
          size="xs"
          color="neutral"
          variant="soft"
          @click="emit('respond', request, false)"
        >Cancel</Button>
      </div>
      <div v-else class="flex gap-2">
        <Button size="xs" color="primary" @click="emit('respond', request, '')"
        >Submit empty</Button>
        <Button
          size="xs"
          color="neutral"
          variant="soft"
          @click="emit('respond', request)"
        >Cancel</Button>
      </div>
    </div>
  </section>
</template>
