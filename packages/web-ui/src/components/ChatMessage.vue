<script setup lang="ts">
import { Comark } from "@comark/vue";
import math, { Math as ComarkMath } from "@comark/vue/plugins/math";
import security from "@comark/vue/plugins/security";
import { computed, onBeforeUnmount, ref } from "vue";
import type { UiBlock, UiMessage } from "@agentaz/protocol";
import { useToast } from "../composables/app-toast";

type MarkdownNode =
  string | [string | null, Record<string, unknown>, ...MarkdownNode[]];

type ToolCallBlock = Extract<UiBlock, { type: "tool_call" }>;
type ToolResultBlock = Extract<UiBlock, { type: "tool_result" }>;
type RenderBlock =
  | Exclude<UiBlock, { type: "tool_call" | "tool_result" }>
  | {
      id: string;
      type: "tool";
      toolCallId: string;
      toolName: string;
      status: ToolCallBlock["status"];
      input: unknown;
      result?: ToolResultBlock;
    };

const props = defineProps<{
  message: UiMessage;
  showWorkingIndicator?: boolean;
  canForkRevert?: boolean;
  isForking?: boolean;
  isReverting?: boolean;
}>();

const emit = defineEmits<{
  (event: "fork" | "revert", message: UiMessage): void;
}>();

const toast = useToast();
const articleRef = ref<HTMLElement | null>(null);
const collapsedStates = ref<Record<string, boolean>>({});
const hasCopiedMarkdown = ref(false);
const markdownOptions = { html: false };
const markdownComponents = { math: ComarkMath };
const markdownPlugins = [
  math({ throwOnError: false }),
  security({
    allowDataImages: false,
    allowedProtocols: ["http", "https", "mailto", "tel"],
    blockedTags: ["iframe", "object", "script", "style"],
  }),
  plainMarkdownOnly(),
];
const allowedMarkdownTags = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "input",
  "li",
  "math",
  "ol",
  "p",
  "pre",
  "s",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);
const renderedBlocks = computed<RenderBlock[]>(() => {
  const resultByCallId = new Map<string, ToolResultBlock>();
  const callIds = new Set<string>();

  for (const block of props.message.blocks) {
    if (block.type === "tool_call") callIds.add(block.toolCallId);
    if (block.type === "tool_result")
      resultByCallId.set(block.toolCallId, block);
  }

  return props.message.blocks.flatMap((block): RenderBlock[] => {
    if (block.type === "tool_call") {
      const result = resultByCallId.get(block.toolCallId);
      return [
        {
          id: block.id,
          type: "tool",
          toolCallId: block.toolCallId,
          toolName: block.toolName || "tool",
          status: result?.isError ? "error" : block.status,
          input: block.input,
          result,
        },
      ];
    }

    if (block.type === "tool_result") {
      if (callIds.has(block.toolCallId)) return [];
      return [
        {
          id: block.id,
          type: "tool",
          toolCallId: block.toolCallId,
          toolName: "tool",
          status: block.isError ? "error" : "completed",
          input: undefined,
          result: block,
        },
      ];
    }

    return [block];
  });
});
const copyableMarkdown = computed(() =>
  props.message.blocks
    .filter((block): block is Extract<UiBlock, { type: "text" }> => {
      return block.type === "text" && Boolean(block.text.trim());
    })
    .map(block => block.text.trim())
    .join("\n\n"),
);
const canCopyMarkdown = computed(
  () => props.message.role === "assistant" && Boolean(copyableMarkdown.value),
);
let copyFeedbackTimer: number | null = null;

function getBlockKey(block: UiBlock, index: number): string {
  return block.id || `${props.message.id}-${index}`;
}

function isBlockCollapsed(key: string, defaultState = true) {
  if (collapsedStates.value[key] === undefined) {
    collapsedStates.value[key] = defaultState;
  }
  return collapsedStates.value[key];
}

function toggleBlock(key: string) {
  collapsedStates.value[key] = !collapsedStates.value[key];
}

function toolCardKey(block: Extract<RenderBlock, { type: "tool" }>) {
  return `${block.id}:combined`;
}

function toolStatusLabel(status: ToolCallBlock["status"]) {
  if (status === "pending") return "pending";
  if (status === "running") return "running";
  if (status === "completed") return "done";
  if (status === "error") return "error";
  return "blocked";
}

function formatToolInput(input: unknown) {
  if (input === undefined || input === null) return "No input.";
  if (isEmptyObject(input)) return "No input.";
  return formatHumanReadable(input);
}

function formatToolResult(result?: ToolResultBlock, status?: string) {
  if (!result) return "Waiting for output.";
  if (!result.content.trim()) {
    if (status === "running") return "";
    return result.isError ? "No error details." : "No output.";
  }
  return formatHumanReadable(result.content);
}

function formatHumanReadable(value: unknown, depth = 0): string {
  const parsed = parseJsonString(value);
  if (parsed !== value) return formatHumanReadable(parsed, depth);

  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value.trimEnd();
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return formatArray(value, depth);
  if (typeof value === "object") return formatObject(value, depth);
  return String(value);
}

function formatArray(values: unknown[], depth: number) {
  if (values.length === 0) return "None.";
  if (values.every(isPrimitiveValue)) {
    return values.map(value => formatHumanReadable(value, depth)).join(", ");
  }

  const prefix = "  ".repeat(depth);
  return values
    .map(value => {
      const formatted = formatHumanReadable(value, depth + 1);
      if (!formatted.includes("\n")) return `${prefix}- ${formatted}`;
      return `${prefix}- ${formatted.replaceAll("\n", `\n${prefix}  `)}`;
    })
    .join("\n");
}

function formatObject(value: object, depth: number) {
  const entries = Object.entries(value).filter(
    ([, item]) => item !== undefined,
  );
  if (entries.length === 0) return "None.";

  const prefix = "  ".repeat(depth);
  return entries
    .map(([key, item]) => {
      const label = humanizeKey(key);
      const formatted = formatHumanReadable(item, depth + 1);
      if (!formatted.includes("\n")) return `${prefix}${label}: ${formatted}`;
      return `${prefix}${label}:\n${formatted}`;
    })
    .join("\n");
}

function parseJsonString(value: unknown) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("[")))
    return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function humanizeKey(key: string) {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, char => char.toUpperCase());
}

function isPrimitiveValue(value: unknown) {
  return (
    value === null || ["string", "number", "boolean"].includes(typeof value)
  );
}

function isEmptyObject(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function formatTime(timestamp?: number) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function roleLabel(role: UiMessage["role"]) {
  if (role === "assistant") return "ai";
  if (role === "user") return "You";
  return role;
}

async function copyMarkdown() {
  if (!copyableMarkdown.value) return;

  try {
    await navigator.clipboard.writeText(copyableMarkdown.value);
    hasCopiedMarkdown.value = true;
    if (copyFeedbackTimer !== null) window.clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = window.setTimeout(() => {
      hasCopiedMarkdown.value = false;
      copyFeedbackTimer = null;
    }, 1500);
  } catch {
    toast.add({
      title: "Copy failed",
      description: "Clipboard access was blocked by the browser.",
      color: "error",
    });
  }
}

/**
 * Moves keyboard focus and scroll position to the start of this message.
 *
 * The workspace calls this after an assistant turn completes so keyboard and
 * screen-reader users land at the beginning of the final response rather than
 * remaining at the composer or transcript bottom.
 */
function focusStart() {
  const article = articleRef.value;
  if (!article) return;
  article.focus({ preventScroll: true });
  article.scrollIntoView({
    block: "start",
    inline: "nearest",
    behavior: "smooth",
  });
}

defineExpose({ focusStart });

onBeforeUnmount(() => {
  if (copyFeedbackTimer !== null) window.clearTimeout(copyFeedbackTimer);
});

function plainMarkdownOnly() {
  return {
    name: "agentaz-plain-markdown-only",
    post(state: { tree: { nodes: MarkdownNode[] } }) {
      state.tree.nodes = filterMarkdownNodes(state.tree.nodes);
    },
  };
}

function filterMarkdownNodes(nodes: MarkdownNode[]): MarkdownNode[] {
  return nodes.flatMap(node => {
    if (typeof node === "string") return [node];

    const [tag, attributes, ...children] = node;
    if (tag === null) return [];

    const filteredChildren = filterMarkdownNodes(children);
    if (!allowedMarkdownTags.has(tag.toLowerCase())) return filteredChildren;

    return [
      [tag, filterMarkdownAttributes(tag, attributes), ...filteredChildren],
    ];
  });
}

function filterMarkdownAttributes(
  tag: string,
  attributes: Record<string, unknown>,
) {
  const filtered: Record<string, unknown> = {};
  if (attributes.$) filtered.$ = attributes.$;

  if (tag === "a") {
    if (typeof attributes.href === "string") filtered.href = attributes.href;
    if (typeof attributes.title === "string") filtered.title = attributes.title;
  }

  if (tag === "code" || tag === "pre") {
    if (typeof attributes.class === "string") filtered.class = attributes.class;
  }

  if (tag === "math") {
    if (typeof attributes.class === "string") filtered.class = attributes.class;
    if (typeof attributes.content === "string")
      filtered.content = attributes.content;
  }

  if (tag === "input") {
    if (attributes.type === "checkbox") filtered.type = attributes.type;
    if (typeof attributes.checked === "boolean")
      filtered.checked = attributes.checked;
    if (typeof attributes.disabled === "boolean")
      filtered.disabled = attributes.disabled;
  }

  return filtered;
}
</script>

<template>
  <article
    ref="articleRef"
    tabindex="-1"
    class="flex scroll-mt-4 gap-2 px-1 py-2 text-left transition-colors duration-150 hover:bg-muted/30 focus:outline-none focus:ring-2 focus:ring-ring/25 sm:scroll-mt-6 sm:gap-4 sm:rounded-lg sm:px-4 sm:py-3"
    style="content-visibility: auto; contain-intrinsic-size: 0 120px"
  >
    <div class="hidden shrink-0 sm:block">
      <div
        v-if="message.role === 'user'"
        class="flex size-9 items-center justify-center rounded-lg bg-secondary text-secondary-foreground font-semibold text-sm"
      >
        U
      </div>
      <div
        v-else
        class="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-semibold text-sm"
      >
        AZ
      </div>
    </div>

    <div class="flex-1 min-w-0 space-y-1.5">
      <div class="flex min-w-0 items-center gap-2">
        <span class="shrink-0 text-xs font-semibold text-foreground sm:text-sm">
          {{ roleLabel(message.role) }}
        </span>
        <span
          v-if="message.createdAt"
          class="min-w-0 truncate text-[10px] font-normal text-muted-foreground sm:text-[11px]"
        >
          {{ formatTime(message.createdAt) }}
        </span>
        <Tooltip v-if="canCopyMarkdown" text="Copy markdown">
          <Button
            type="button"
            color="neutral"
            variant="ghost"
            size="xs"
            :icon="hasCopiedMarkdown ? 'i-lucide-check' : 'i-lucide-copy'"
            :aria-label="
              hasCopiedMarkdown ? 'Copied markdown' : 'Copy markdown'
            "
            class="ml-auto shrink-0"
            @click="copyMarkdown"
          />
        </Tooltip>
      </div>

      <div class="space-y-1">
        <div v-for="(block, index) in renderedBlocks" :key="block.id">
          <!-- Text Block -->
          <div v-if="block.type === 'text'">
            <div
              v-if="message.role === 'tool'"
              class="my-1.5 rounded-lg border border-border bg-background overflow-hidden shadow-inner"
            >
              <div
                class="flex items-center justify-between px-3 py-1.5 bg-muted border-b border-border text-[11px] font-mono text-muted-foreground select-none"
              >
                <span class="flex items-center gap-1.5">
                  <AppIcon
                    name="i-lucide-terminal"
                    class="size-3.5 text-muted-foreground"
                  />
                  Tool Output
                </span>
              </div>
              <div
                class="p-3 bg-background font-mono text-xs leading-normal text-left"
              >
                <pre
                  class="overflow-y-auto max-h-72 whitespace-pre-wrap break-all text-foreground font-mono text-[11px] leading-relaxed"
                  >{{ block.text }}</pre>
              </div>
            </div>

            <div
              v-else
              class="min-w-0 text-sm leading-relaxed text-foreground/90 wrap-break-word"
            >
              <Suspense>
                <Comark
                  :markdown="block.text"
                  :options="markdownOptions"
                  :plugins="markdownPlugins"
                  :components="markdownComponents"
                  streaming
                  class="agentaz-markdown max-w-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_.math.block]:my-2 [&_.math.block]:max-w-full [&_.math.block]:overflow-x-auto [&_a]:wrap-break-word [&_code]:wrap-break-word [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:wrap-break-word [&_ul]:my-2 [&_ul]:pl-5"
                />
                <template #fallback>
                  <div
                    class="agentaz-markdown max-w-full whitespace-pre-wrap wrap-break-word"
                  >
                    {{ block.text }}
                  </div>
                </template>
              </Suspense>
            </div>
          </div>

          <!-- Thinking Block -->
          <div
            v-else-if="block.type === 'thinking' && block.text"
            class="my-1.5 overflow-hidden rounded-lg border border-border bg-muted/20"
          >
            <button
              type="button"
              class="flex w-full items-center gap-2 px-2.5 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 sm:px-3"
              @click="toggleBlock(getBlockKey(block, index))"
            >
              <AppIcon name="i-lucide-brain" class="size-4 shrink-0" />
              <span>Thinking</span>
              <AppIcon
                :name="
                  isBlockCollapsed(
                    getBlockKey(block, index),
                    block.collapsed ?? true,
                  )
                    ? 'i-lucide-chevron-right'
                    : 'i-lucide-chevron-down'
                "
                class="size-3 shrink-0 opacity-60 ml-auto"
              />
            </button>
            <div
              v-show="
                !isBlockCollapsed(
                  getBlockKey(block, index),
                  block.collapsed ?? true,
                )
              "
              class="border-t border-border/30 p-3"
            >
              <pre
                class="whitespace-pre-wrap wrap-break-word text-xs leading-relaxed text-muted-foreground font-sans"
                >{{ block.text }}</pre>
            </div>
          </div>

          <!-- Tool Block -->
          <div
            v-else-if="block.type === 'tool'"
            class="my-1.5 overflow-hidden rounded-lg border border-border bg-muted/10"
          >
            <button
              type="button"
              class="flex w-full items-center gap-2 px-2.5 py-2 text-xs font-semibold hover:bg-muted/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 sm:px-3"
              @click="toggleBlock(toolCardKey(block))"
            >
              <AppIcon
                name="i-lucide-wrench"
                class="size-4 shrink-0 text-muted-foreground"
              />
              <span class="relative flex h-2 w-2 shrink-0">
                <span
                  v-if="block.status === 'running'"
                  class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-blue-400"
                />
                <span
                  class="relative inline-flex rounded-full h-2 w-2"
                  :class="{
                    'bg-amber-500': block.status === 'pending',
                    'bg-blue-500': block.status === 'running',
                    'bg-emerald-500': block.status === 'completed',
                    'bg-red-500': block.status === 'error',
                    'bg-muted-foreground': block.status === 'blocked',
                  }"
                />
              </span>
              <span class="min-w-0 truncate">{{ block.toolName }}</span>
              <span
                class="inline-flex items-center rounded-md border border-transparent bg-secondary px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-secondary-foreground"
              >
                {{ toolStatusLabel(block.status) }}
              </span>
              <AppIcon
                :name="
                  isBlockCollapsed(toolCardKey(block), true)
                    ? 'i-lucide-chevron-right'
                    : 'i-lucide-chevron-down'
                "
                class="size-3 shrink-0 opacity-60 ml-auto"
              />
            </button>
            <div
              v-show="!isBlockCollapsed(toolCardKey(block), true)"
              class="border-t border-border/30 p-3 space-y-3"
            >
              <section class="space-y-1.5">
                <div
                  class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  <AppIcon name="i-lucide-arrow-down-to-line" class="size-3.5" />
                  <span>Input</span>
                </div>
                <pre
                  class="overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-md bg-background/60 p-2.5 text-xs leading-relaxed text-foreground/80 font-mono"
                  >{{ formatToolInput(block.input) }}</pre>
              </section>
              <section class="space-y-1.5">
                <div
                  class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide"
                  :class="
                    block.result?.isError
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-muted-foreground'
                  "
                >
                  <AppIcon
                    :name="
                      block.result?.isError
                        ? 'i-lucide-circle-alert'
                        : 'i-lucide-arrow-up-from-line'
                    "
                    class="size-3.5"
                  />
                  <span>{{ block.result?.isError ? "Error" : "Output" }}</span>
                </div>
                <pre
                  class="overflow-y-auto max-h-72 whitespace-pre-wrap wrap-break-word rounded-md bg-background/60 p-2.5 text-xs leading-relaxed font-mono"
                  :class="
                    block.result?.isError
                      ? 'text-red-700/90 dark:text-red-300/90'
                      : 'text-foreground/80'
                  "
                  >{{ formatToolResult(block.result, block.status) }}</pre>
              </section>
            </div>
          </div>
        </div>

        <div
          v-if="props.showWorkingIndicator"
          role="status"
          aria-live="polite"
          class="flex items-center gap-2 pt-1 text-sm text-muted-foreground"
        >
          <AppIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
          <span>working...</span>
        </div>
      </div>
    </div>
  </article>
  <div
    v-if="message.role === 'user' && message.rewindEntryId"
    class="-mt-2 flex justify-end gap-1 px-1 pb-1 sm:-mt-3 sm:px-4"
  >
    <Button
      type="button"
      color="neutral"
      variant="ghost"
      size="xs"
      icon="i-lucide-git-fork"
      :loading="props.isForking"
      :disabled="!props.canForkRevert || props.isReverting"
      @click="emit('fork', message)"
    >
      Fork
    </Button>
    <Button
      type="button"
      color="neutral"
      variant="ghost"
      size="xs"
      icon="i-lucide-rotate-ccw"
      :loading="props.isReverting"
      :disabled="!props.canForkRevert || props.isForking"
      @click="emit('revert', message)"
    >
      Revert
    </Button>
  </div>
</template>
