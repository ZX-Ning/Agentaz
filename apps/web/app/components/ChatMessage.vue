<script setup lang="ts">
import math, { Math as ComarkMath } from "@comark/nuxt/plugins/math";
import security from "@comark/nuxt/plugins/security";
import { computed, ref } from "vue";
import type { UiBlock, UiMessage } from "../../types/protocol";

type MarkdownNode =
  | string
  | [string | null, Record<string, unknown>, ...MarkdownNode[]];

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
}>();

const collapsedStates = ref<Record<string, boolean>>({});
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
    if (block.type === "tool_result") resultByCallId.set(block.toolCallId, block);
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

function formatToolResult(result?: ToolResultBlock) {
  if (!result) return "Waiting for output.";
  if (!result.content.trim()) return result.isError ? "No error details." : "No output.";
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
    return values.map((value) => formatHumanReadable(value, depth)).join(", ");
  }

  const prefix = "  ".repeat(depth);
  return values
    .map((value) => {
      const formatted = formatHumanReadable(value, depth + 1);
      if (!formatted.includes("\n")) return `${prefix}- ${formatted}`;
      return `${prefix}- ${formatted.replaceAll("\n", `\n${prefix}  `)}`;
    })
    .join("\n");
}

function formatObject(value: object, depth: number) {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
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
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function isPrimitiveValue(value: unknown) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
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

function plainMarkdownOnly() {
  return {
    name: "agentaz-plain-markdown-only",
    post(state: { tree: { nodes: MarkdownNode[] } }) {
      state.tree.nodes = filterMarkdownNodes(state.tree.nodes);
    },
  };
}

function filterMarkdownNodes(nodes: MarkdownNode[]): MarkdownNode[] {
  return nodes.flatMap((node) => {
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
    class="flex gap-4 px-4 py-3 hover:bg-muted/30 transition-colors duration-150 rounded-lg text-left"
    style="content-visibility: auto; contain-intrinsic-size: 0 120px"
  >
    <div class="flex-shrink-0">
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
      <div class="flex items-baseline gap-2">
        <span class="text-sm font-semibold text-foreground">
          {{ roleLabel(message.role) }}
        </span>
        <span
          v-if="message.createdAt"
          class="text-[11px] text-muted-foreground font-normal font-sans"
        >
          {{ formatTime(message.createdAt) }}
        </span>
      </div>

      <div class="space-y-1">
        <div v-for="(block, index) in renderedBlocks" :key="block.id">
          <!-- Text Block -->
          <div v-if="block.type === 'text'">
            <div
              v-if="message.role === 'tool'"
              class="my-1.5 rounded-lg border border-border bg-slate-950 overflow-hidden shadow-inner"
            >
              <div
                class="flex items-center justify-between px-3 py-1.5 bg-slate-900 border-b border-slate-800 text-[11px] font-mono text-slate-400 select-none"
              >
                <span class="flex items-center gap-1.5">
                  <UIcon
                    name="i-lucide-terminal"
                    class="size-3.5 text-slate-400"
                  />
                  Tool Output
                </span>
              </div>
              <div
                class="p-3 bg-slate-950 font-mono text-xs leading-normal text-left"
              >
                <pre
                  class="overflow-y-auto max-h-72 whitespace-pre-wrap break-all text-slate-100 font-mono text-[11px] leading-relaxed"
                  >{{ block.text }}</pre
                >
              </div>
            </div>

            <div
              v-else
              class="min-w-0 text-sm text-foreground/90 leading-relaxed font-sans break-words"
            >
              <Comark
                :markdown="block.text"
                :options="markdownOptions"
                :plugins="markdownPlugins"
                :components="markdownComponents"
                streaming
                class="max-w-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_.math.block]:my-2 [&_.math.block]:max-w-full [&_.math.block]:overflow-x-auto [&_a]:break-words [&_code]:break-words [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_ul]:my-2 [&_ul]:pl-5"
              />
            </div>
          </div>

          <!-- Thinking Block -->
          <div
            v-else-if="block.type === 'thinking' && block.text"
            class="my-1.5 rounded-lg border border-border bg-muted/20 overflow-hidden"
          >
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
              @click="toggleBlock(getBlockKey(block, index))"
            >
              <UIcon name="i-lucide-brain" class="size-4 shrink-0" />
              <span>Thinking</span>
              <UIcon
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
                class="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground font-sans"
                >{{ block.text }}</pre
              >
            </div>
          </div>

          <!-- Tool Block -->
          <div
            v-else-if="block.type === 'tool'"
            class="my-1.5 rounded-lg border overflow-hidden"
            :class="{
              'border-amber-500/30 bg-amber-50/5 dark:bg-amber-950/5':
                block.status === 'pending',
              'border-blue-500/30 bg-blue-50/5 dark:bg-blue-950/5':
                block.status === 'running',
              'border-emerald-500/30 bg-emerald-50/5 dark:bg-emerald-950/5':
                block.status === 'completed',
              'border-red-500/30 bg-red-50/5 dark:bg-red-950/5':
                block.status === 'error',
              'border-border bg-muted/10': block.status === 'blocked',
            }"
          >
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-muted/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
              @click="toggleBlock(toolCardKey(block))"
            >
              <UIcon
                name="i-lucide-wrench"
                class="size-4 shrink-0"
                :class="{
                  'text-amber-500': block.status === 'pending',
                  'text-blue-500 animate-pulse': block.status === 'running',
                  'text-emerald-500': block.status === 'completed',
                  'text-red-500': block.status === 'error',
                  'text-muted-foreground': block.status === 'blocked',
                }"
              />
              <span class="min-w-0 truncate">{{ block.toolName }}</span>
              <UBadge
                size="xs"
                variant="soft"
                :color="
                  {
                    pending: 'warning',
                    running: 'info',
                    completed: 'success',
                    error: 'error',
                    blocked: 'neutral',
                  }[block.status] as any
                "
              >
                {{ toolStatusLabel(block.status) }}
              </UBadge>
              <UIcon
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
                  <UIcon name="i-lucide-arrow-down-to-line" class="size-3.5" />
                  <span>Input</span>
                </div>
                <pre
                  class="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-2.5 text-xs leading-relaxed text-foreground/80 font-mono"
                  >{{ formatToolInput(block.input) }}</pre
                >
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
                  <UIcon
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
                  class="overflow-y-auto max-h-72 whitespace-pre-wrap break-words rounded-md bg-background/60 p-2.5 text-xs leading-relaxed font-mono"
                  :class="
                    block.result?.isError
                      ? 'text-red-700/90 dark:text-red-300/90'
                      : 'text-foreground/80'
                  "
                  >{{ formatToolResult(block.result) }}</pre
                >
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  </article>
</template>
