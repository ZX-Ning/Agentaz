<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type {
  PermissionConfigResponse,
  PermissionRuleValue,
  PermissionState,
  PermissionSurfacePolicy,
  PermissionSystemConfig,
} from "@agentaz/protocol";
import type { AgentazPermissions } from "../composables/agentaz-permissions";
import { useToast } from "../composables/app-toast";

const props = defineProps<{
  open: boolean;
  permissions: AgentazPermissions;
}>();

const emit = defineEmits<{
  (event: "update:open", value: boolean): void;
}>();

type PermissionActionChoice = PermissionState | "custom";

type ToolSurface = {
  key: string;
  label: string;
  description: string;
};

const commonToolSurfaces: ToolSurface[] = [
  { key: "read", label: "Read", description: "Read files from disk." },
  { key: "grep", label: "Grep", description: "Search file contents." },
  { key: "find", label: "Find", description: "Discover files by pattern." },
  { key: "ls", label: "List", description: "List directory contents." },
  { key: "bash", label: "Bash", description: "Run shell commands." },
  { key: "edit", label: "Edit", description: "Patch existing files." },
  { key: "write", label: "Write", description: "Create or overwrite files." },
  {
    key: "external_directory",
    label: "External dirs",
    description: "Access paths outside the workspace cwd.",
  },
];

const actionChoices: PermissionState[] = ["allow", "ask", "deny"];
const toast = useToast();
const response = ref<PermissionConfigResponse | null>(null);
const draftConfig = ref<PermissionSystemConfig | null>(null);
const isLoading = ref(false);
const isSaving = ref(false);
const isResetting = ref(false);
const loadError = ref<string | null>(null);
const isDiscardConfirmOpen = ref(false);

const pathPolicyEntries = computed(() => {
  const pathPolicy = draftConfig.value?.permission.path;
  if (!pathPolicy) {
    return [];
  }
  if (typeof pathPolicy === "string") {
    return [{ pattern: "*", value: pathPolicy }];
  }
  return Object.entries(pathPolicy).map(([pattern, value]) => ({
    pattern,
    value: formatRuleValue(value),
  }));
});

const customSurfaceCount = computed(() => {
  const permission = draftConfig.value?.permission ?? {};
  return Object.entries(permission).filter(([surface, policy]) =>
    !commonToolSurfaces.some((tool) => tool.key === surface) &&
    surface !== "path" &&
    typeof policy === "object"
  ).length;
});

const permissionStateLabel = computed(() => {
  if (!response.value) {
    return "Loading project permissions...";
  }
  return response.value.exists
    ? "Project override active"
    : "No project override. Using fallback/default permissions.";
});

const hasUnsavedChanges = computed(() => {
  if (!response.value?.config || !draftConfig.value) {
    return false;
  }
  return JSON.stringify(response.value.config) !==
    JSON.stringify(draftConfig.value);
});

watch(
  () => props.open,
  (open) => {
    if (open) {
      void loadConfig();
      return;
    }
    loadError.value = null;
    isDiscardConfirmOpen.value = false;
  },
);

async function loadConfig() {
  isLoading.value = true;
  loadError.value = null;
  try {
    const next = await props.permissions.loadPermissionConfig();
    if (!next?.config) {
      throw new Error("Permission config response is missing config data.");
    }
    response.value = next;
    draftConfig.value = cloneConfig(next.config);
  }
  catch (error) {
    // Keep the modal actionable even when the backend is older, offline, or
    // returns a validation error. agentFetch already emits the global toast.
    loadError.value = error instanceof Error ? error.message : String(error);
    response.value = null;
    draftConfig.value = null;
  }
  finally {
    isLoading.value = false;
  }
}

async function saveConfig() {
  if (!draftConfig.value) {
    return;
  }

  isSaving.value = true;
  try {
    const next = await props.permissions.savePermissionConfig(
      draftConfig.value,
    );
    response.value = next;
    draftConfig.value = cloneConfig(next.config);
    toast.add({
      title: "Permissions saved",
      description: "Changes apply to future permission checks.",
      color: "success",
    });
  }
  finally {
    isSaving.value = false;
  }
}

async function resetConfig() {
  isResetting.value = true;
  try {
    const next = await props.permissions.resetPermissionConfig();
    response.value = next;
    draftConfig.value = cloneConfig(next.config);
    toast.add({
      title: "Project override reset",
      description:
        "Permission-system will fall back outside this project layer.",
      color: "success",
    });
  }
  finally {
    isResetting.value = false;
  }
}

function handleDialogOpenChange(nextOpen: boolean) {
  if (nextOpen) {
    emit("update:open", true);
    return;
  }
  requestClose();
}

function requestClose() {
  if (hasUnsavedChanges.value) {
    isDiscardConfirmOpen.value = true;
    return;
  }
  emit("update:open", false);
}

function discardChangesAndClose() {
  isDiscardConfirmOpen.value = false;
  emit("update:open", false);
}

function cloneConfig(config: PermissionSystemConfig): PermissionSystemConfig {
  return structuredClone(config);
}

function toolAction(surface: string): PermissionActionChoice {
  const policy = draftConfig.value?.permission[surface];
  return typeof policy === "string" ? policy : "custom";
}

function setToolAction(surface: string, action: PermissionState) {
  if (!draftConfig.value) {
    return;
  }
  draftConfig.value.permission[surface] = action;
}

function formatRuleValue(value: PermissionRuleValue | PermissionSurfacePolicy) {
  if (typeof value === "string") {
    return value;
  }
  if ("action" in value) {
    return value.reason ? `${value.action}: ${value.reason}` : value.action;
  }
  return "custom";
}

function updateFlag(
  key: "debugLog" | "permissionReviewLog" | "yoloMode",
  event: Event,
) {
  if (!draftConfig.value) {
    return;
  }
  draftConfig.value[key] = (event.target as HTMLInputElement).checked;
}
</script>

<template>
  <Dialog
    :open="open"
    title="Project permissions"
    :ui="{ content: 'max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl' }"
    @update:open="handleDialogOpenChange"
  >
    <template #body>
      <div class="mt-4 space-y-5 text-sm">
        <section
          class="rounded-lg border border-border bg-muted/40 px-3 py-2 text-foreground"
        >
          <div class="flex items-center gap-3">
            <AppIcon
              name="i-lucide-shield-check"
              class="size-4 text-muted-foreground"
            />
            <div class="text-sm font-medium">
              {{ permissionStateLabel }}
            </div>
          </div>
        </section>

        <div
          v-if="isLoading && !draftConfig"
          class="flex items-center justify-center gap-2 rounded-lg border border-border p-6 text-muted-foreground"
        >
          <AppIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
          Loading permissions...
        </div>
        <div
          v-else-if="loadError"
          class="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-destructive"
        >
          <div class="flex items-start gap-3">
            <AppIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4" />
            <div class="min-w-0 flex-1 space-y-2">
              <div class="font-medium">Could not load permission settings</div>
              <p class="text-xs opacity-90">
                {{ loadError }}
              </p>
              <Button
                color="neutral"
                variant="soft"
                size="sm"
                :loading="isLoading"
                @click="loadConfig"
              >
                Retry
              </Button>
            </div>
          </div>
        </div>

        <template v-else-if="draftConfig">
          <section class="space-y-3">
            <div>
              <h3 class="text-sm font-semibold">Runtime options</h3>
              <p class="text-xs text-muted-foreground">
                These flags are stored with the project permission config.
              </p>
            </div>

            <div class="grid gap-2 sm:grid-cols-3">
              <label
                class="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card p-3"
              >
                <input
                  type="checkbox"
                  class="mt-0.5 size-4 accent-primary"
                  :checked="draftConfig.yoloMode"
                  @change="updateFlag('yoloMode', $event)"
                />
                <span>
                  <span class="block font-medium">YOLO mode</span>
                  <span class="block text-xs text-muted-foreground">
                    Auto-approve ask-state checks.
                  </span>
                </span>
              </label>

              <label
                class="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card p-3"
              >
                <input
                  type="checkbox"
                  class="mt-0.5 size-4 accent-primary"
                  :checked="draftConfig.permissionReviewLog"
                  @change="updateFlag('permissionReviewLog', $event)"
                />
                <span>
                  <span class="block font-medium">Review log</span>
                  <span class="block text-xs text-muted-foreground">
                    Write request/decision audit events.
                  </span>
                </span>
              </label>

              <label
                class="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card p-3"
              >
                <input
                  type="checkbox"
                  class="mt-0.5 size-4 accent-primary"
                  :checked="draftConfig.debugLog"
                  @change="updateFlag('debugLog', $event)"
                />
                <span>
                  <span class="block font-medium">Debug log</span>
                  <span class="block text-xs text-muted-foreground">
                    Verbose extension diagnostics.
                  </span>
                </span>
              </label>
            </div>
          </section>

          <section class="space-y-3">
            <div>
              <h3 class="text-sm font-semibold">Common tool permissions</h3>
              <p class="text-xs text-muted-foreground">
                Custom means this surface currently uses pattern rules. Choosing
                allow, ask, or deny replaces those custom rules for that tool.
              </p>
            </div>

            <div
              class="divide-y divide-border overflow-hidden rounded-lg border border-border">
              <div
                v-for="tool in commonToolSurfaces"
                :key="tool.key"
                class="grid gap-3 bg-card p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div class="min-w-0">
                  <div class="font-medium">{{ tool.label }}</div>
                  <div class="text-xs text-muted-foreground">
                    {{ tool.description }}
                  </div>
                </div>

                <div class="flex flex-wrap items-center gap-1">
                  <span
                    v-if="toolAction(tool.key) === 'custom'"
                    class="rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
                  >
                    Custom
                  </span>
                  <button
                    v-for="action in actionChoices"
                    :key="action"
                    type="button"
                    :class="[
                      'rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35',
                      toolAction(tool.key) === action
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
                    ]"
                    @click="setToolAction(tool.key, action)"
                  >
                    {{ action }}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section class="space-y-3">
            <div>
              <h3 class="text-sm font-semibold">Path rules summary</h3>
              <p class="text-xs text-muted-foreground">
                Pattern editing is reserved for a later version; existing rules
                are preserved unless you edit raw config outside Agentaz.
              </p>
            </div>

            <div
              v-if="pathPolicyEntries.length"
              class="overflow-hidden rounded-lg border border-border bg-card"
            >
              <div
                v-for="entry in pathPolicyEntries"
                :key="entry.pattern"
                class="flex items-start justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0"
              >
                <code class="break-all text-xs text-foreground">
                  {{ entry.pattern }}
                </code>
                <span
                  class="shrink-0 text-xs font-medium text-muted-foreground">
                  {{ entry.value }}
                </span>
              </div>
            </div>
            <div v-else
              class="rounded-lg border border-border p-3 text-muted-foreground">
              No path rules in this config.
            </div>

            <p v-if="customSurfaceCount" class="text-xs text-muted-foreground">
              {{ customSurfaceCount }} additional custom permission surface(s)
              are preserved but not shown here.
            </p>
          </section>
        </template>

        <footer
          class="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:justify-between">
          <Button
            color="neutral"
            variant="ghost"
            :loading="isResetting"
            :disabled="isLoading || isSaving || !response?.exists"
            @click="resetConfig"
          >
            Reset project override
          </Button>

          <div class="flex justify-end gap-2">
            <Button
              color="neutral"
              variant="ghost"
              @click="requestClose"
            >
              Close
            </Button>
            <Button
              :loading="isSaving"
              :disabled="isLoading || isResetting || !draftConfig"
              @click="saveConfig"
            >
              Save changes
            </Button>
          </div>
        </footer>
      </div>
    </template>
  </Dialog>

  <Dialog
    :open="isDiscardConfirmOpen"
    title="Discard unsaved changes?"
    :ui="{ content: 'sm:max-w-md' }"
    @update:open="isDiscardConfirmOpen = $event"
  >
    <template #body>
      <div class="mt-4 space-y-4 text-sm">
        <p class="text-muted-foreground">
          You have unsaved permission changes. Close without saving them?
        </p>
        <div class="flex justify-end gap-2">
          <Button
            color="neutral"
            variant="ghost"
            type="button"
            @click="isDiscardConfirmOpen = false"
          >
            Keep editing
          </Button>
          <Button color="error" type="button" @click="discardChangesAndClose">
            Discard changes
          </Button>
        </div>
      </div>
    </template>
  </Dialog>
</template>
