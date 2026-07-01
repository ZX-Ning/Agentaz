<script setup lang="ts">
import { ref } from "vue";
import type { SessionListItem } from "../types/sessions";

defineProps<{
  open: boolean;
  clientId: string;
  sessions: SessionListItem[];
  workingDir: string;
}>();

const emit = defineEmits<{
  (event: "update:open", value: boolean): void;
  (event: "create"): void;
  // (event: "loadDummy"): void;
  (event: "select" | "delete", session: SessionListItem): void;
  (event: "rename", payload: { session: SessionListItem; name: string }): void;
}>();

const isRenameOpen = ref(false);
const sessionBeingRenamed = ref<SessionListItem | null>(null);
const renameValue = ref("");

function openRenameDialog(session: SessionListItem) {
  if (!session.file || session.isDraft) {
    return;
  }
  sessionBeingRenamed.value = session;
  renameValue.value = session.title;
  isRenameOpen.value = true;
}

function submitRename() {
  const session = sessionBeingRenamed.value;
  const name = renameValue.value.trim();
  if (!session || !session.file || !name) {
    return;
  }
  emit("rename", { session, name });
  isRenameOpen.value = false;
}

function sessionMenuItems(session: SessionListItem) {
  const hasPersistedFile = Boolean(session.file) && !session.isDraft;
  return [
    [
      {
        label: "Rename",
        icon: "i-lucide-pencil",
        disabled: !hasPersistedFile,
        onSelect: () => openRenameDialog(session),
      },
      {
        label: "Delete",
        icon: "i-lucide-trash-2",
        color: "error" as const,
        disabled: !hasPersistedFile || session.isWorking,
        onSelect: () => emit("delete", session),
      },
    ],
  ];
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-sm transition-opacity duration-300 lg:hidden"
    @click="emit('update:open', false)"
  />

  <aside
    class="fixed inset-y-0 left-0 z-50 flex w-80 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-4 text-sidebar-foreground shadow-2xl transition-transform duration-300 ease-in-out lg:static lg:z-0 lg:shadow-none lg:transition-all"
    :class="
      open
        ? 'translate-x-0 lg:translate-x-0 lg:w-80 lg:opacity-100'
        : '-translate-x-full lg:translate-x-0 lg:w-0 lg:overflow-hidden lg:border-r-0 lg:p-0 lg:opacity-0'
    "
  >
    <div class="mb-4 flex items-center justify-between px-2 pt-1">
      <div class="flex items-center gap-2">
        <div
          class="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground"
        >
          AZ
        </div>
        <div>
          <div class="text-sm font-semibold">Agentaz</div>
          <div class="text-xs text-muted-foreground font-normal">
            {{ clientId ? `Client ${clientId.slice(0, 8)}` : "Connecting" }}
          </div>
        </div>
      </div>
      <Button
        color="neutral"
        variant="ghost"
        icon="i-lucide-x"
        size="sm"
        class="text-muted-foreground hover:text-foreground lg:hidden"
        @click="emit('update:open', false)"
      />
    </div>

    <Button
      block
      color="neutral"
      variant="soft"
      class="mb-4 justify-start border border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground hover:bg-secondary"
      @click="emit('create')"
    >
      <template #leading>
        <AppIcon name="i-lucide-plus" class="size-4" />
      </template>
      New session
    </Button>

    <!--
    <Button
      block
      color="warning"
      variant="soft"
      class="mb-2 justify-start border border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground hover:bg-secondary"
      @click="emit('loadDummy')"
    >
      <template #leading>
        <AppIcon name="i-lucide-flask-conical" class="size-4" />
      </template>
      Load Dummy (300 msgs)
    </Button>
    -->

    <div
      class="space-y-2 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
    >
      Sessions
    </div>
    <div class="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
      <ContextMenu
        v-for="session in sessions"
        :key="session.id"
        :items="sessionMenuItems(session)"
      >
        <button
          class="w-full rounded-lg px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
          :class="
            session.isActive
              ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
              : 'text-sidebar-foreground hover:bg-sidebar-accent'
          "
          @click="emit('select', session)"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="truncate">{{ session.title }}</span>
            <span class="flex shrink-0 items-center gap-1">
              <span
                v-if="session.isStreaming"
                class="inline-flex items-center rounded-md border border-transparent bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-emerald-700 dark:text-emerald-300"
              >run</span>
              <span
                v-if="session.pendingApprovalCount"
                class="inline-flex items-center rounded-md border border-transparent bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-amber-700 dark:text-amber-300"
              >{{ session.pendingApprovalCount }}</span>
              <span
                v-if="session.isActive"
                class="inline-flex items-center rounded-md border border-transparent bg-primary px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-primary-foreground"
              >open</span>
            </span>
          </div>
          <div
            class="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground font-normal"
          >
            <span
              class="truncate">{{ session.sessionId || session.file }}</span>
            <span
              v-if="session.isLoaded"
              class="text-[10px] uppercase font-semibold tracking-wider opacity-60"
            >
              {{ session.isWorking ? "working" : "loaded" }}
            </span>
            <span
              v-else
              class="text-[10px] uppercase font-semibold tracking-wider opacity-60"
            >
              available
            </span>
          </div>
        </button>
      </ContextMenu>
      <Dialog
        v-model:open="isRenameOpen"
        title="Rename session"
        :ui="{ content: 'sm:max-w-lg' }"
      >
        <template #body>
          <form class="space-y-4" @submit.prevent="submitRename">
            <input
              v-model="renameValue"
              autofocus
              maxlength="120"
              placeholder="Session name"
              class="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <div class="flex justify-end gap-2">
              <Button
                color="neutral"
                variant="ghost"
                type="button"
                @click="isRenameOpen = false"
              >
                Cancel
              </Button>
              <Button
                color="primary"
                type="submit"
                :disabled="!renameValue.trim()"
              >
                Save
              </Button>
            </div>
          </form>
        </template>
      </Dialog>
      <div
        v-if="sessions.length === 0"
        class="rounded-lg px-3 py-2 text-sm text-muted-foreground"
      >
        No sessions found
      </div>
    </div>

    <div class="mt-auto pt-4 border-t border-sidebar-border">
      <div
        class="rounded-lg bg-sidebar-accent p-3 text-xs text-muted-foreground"
      >
        <div class="mb-1 font-medium text-sidebar-foreground">
          Working directory
        </div>
        <div class="truncate">{{ workingDir }}</div>
      </div>
    </div>
  </aside>
</template>
