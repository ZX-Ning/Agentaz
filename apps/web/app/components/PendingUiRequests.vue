<script setup lang="ts">
import type { PendingUiRequest } from "../../types/protocol";

defineProps<{
  requests: PendingUiRequest[];
}>();

const emit = defineEmits<{
  (event: "respond", request: PendingUiRequest, value?: string | boolean): void;
}>();
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
      <p
        v-if="request.type === 'ui_confirm_request' && request.message"
        class="whitespace-pre-wrap text-xs text-muted-foreground"
      >
        {{ request.message }}
      </p>
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
        <UButton
          v-for="option in request.options"
          :key="option"
          size="xs"
          color="neutral"
          variant="soft"
          @click="emit('respond', request, option)"
        >
          {{ option }}
        </UButton>
        <UButton
          size="xs"
          color="error"
          variant="soft"
          @click="emit('respond', request)"
          >Cancel</UButton
        >
      </div>
      <div v-else-if="request.type === 'ui_confirm_request'" class="flex gap-2">
        <UButton
          size="xs"
          color="primary"
          @click="emit('respond', request, true)"
          >Confirm</UButton
        >
        <UButton
          size="xs"
          color="neutral"
          variant="soft"
          @click="emit('respond', request, false)"
          >Cancel</UButton
        >
      </div>
      <div v-else class="flex gap-2">
        <UButton size="xs" color="primary" @click="emit('respond', request, '')"
          >Submit empty</UButton
        >
        <UButton
          size="xs"
          color="neutral"
          variant="soft"
          @click="emit('respond', request)"
          >Cancel</UButton
        >
      </div>
    </div>
  </section>
</template>
