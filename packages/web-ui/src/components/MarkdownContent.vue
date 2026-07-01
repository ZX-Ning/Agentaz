<script setup lang="ts">
/**
 * Markdown rendering is intentionally isolated from ChatMessage.
 *
 * This component owns the heavy Markdown stack: Comark, KaTeX math rendering,
 * Shiki syntax highlighting, and the final AST attribute allowlist. ChatMessage
 * lazy-loads this file so the main chat shell can render before the Markdown
 * highlighter bundle is downloaded and initialized.
 *
 * Shiki languages are currently imported as an explicit "common agent output"
 * set. Comark's docs mention on-demand loading for unregistered languages, but
 * the locally installed plugin falls back for at least Python unless the grammar
 * is registered. The explicit list keeps highlighting predictable at the cost of
 * a larger MarkdownContent chunk.
 *
 * Refactor directions:
 * - Replace the static language list with a verified on-demand loader once
 *   Comark/Shiki behavior is stable in this app's bundler.
 * - Move the sanitizer into a focused markdown-security helper if more Markdown
 *   plugins start needing their own tag/attribute rules.
 * - Consider a tiny plain-text renderer for long streaming turns until the
 *   Markdown chunk has loaded, then hydrate into full Markdown rendering.
 */
import { Comark } from "@comark/vue";
import highlight from "@comark/vue/plugins/highlight";
import math, { Math as ComarkMath } from "@comark/vue/plugins/math";
import security from "@comark/vue/plugins/security";
import bash from "shiki/langs/bash.mjs";
import c from "shiki/langs/c.mjs";
import cpp from "shiki/langs/cpp.mjs";
import csharp from "shiki/langs/cs.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import dockerfile from "shiki/langs/dockerfile.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import java from "shiki/langs/java.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsonc from "shiki/langs/jsonc.mjs";
import jsx from "shiki/langs/jsx.mjs";
import markdownLanguage from "shiki/langs/markdown.mjs";
import powershell from "shiki/langs/powershell.mjs";
import python from "shiki/langs/python.mjs";
import rust from "shiki/langs/rust.mjs";
import scss from "shiki/langs/scss.mjs";
import shell from "shiki/langs/shell.mjs";
import sql from "shiki/langs/sql.mjs";
import svelte from "shiki/langs/svelte.mjs";
import toml from "shiki/langs/toml.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import vue from "shiki/langs/vue.mjs";
import xml from "shiki/langs/xml.mjs";
import yaml from "shiki/langs/yaml.mjs";
import darkPlus from "shiki/themes/dark-plus.mjs";
import lightPlus from "shiki/themes/light-plus.mjs";

type MarkdownNode = string | [
  string | null,
  Record<string, unknown>,
  ...MarkdownNode[],
];

defineProps<{
  markdown: string;
}>();

const markdownOptions = { html: false };
const markdownComponents = { math: ComarkMath };
const commonShikiLanguages = [
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  html,
  java,
  javascript,
  json,
  jsonc,
  jsx,
  markdownLanguage,
  powershell,
  python,
  rust,
  scss,
  shell,
  sql,
  svelte,
  toml,
  tsx,
  typescript,
  vue,
  xml,
  yaml,
];
const markdownPlugins = [
  math({ throwOnError: false }),
  highlight({
    languages: commonShikiLanguages,
    themes: { light: lightPlus, dark: darkPlus },
  }),
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
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

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
    if (typeof node === "string") {
      return [node];
    }

    const [tag, attributes, ...children] = node;
    if (tag === null) {
      return [];
    }

    const filteredChildren = filterMarkdownNodes(children);
    if (!allowedMarkdownTags.has(tag.toLowerCase())) {
      return filteredChildren;
    }

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
  if (attributes.$) {
    filtered.$ = attributes.$;
  }

  if (tag === "a") {
    if (typeof attributes.href === "string") {
      filtered.href = attributes.href;
    }
    if (typeof attributes.title === "string") {
      filtered.title = attributes.title;
    }
  }

  if (tag === "code" || tag === "pre") {
    if (typeof attributes.class === "string") {
      filtered.class = attributes.class;
    }
    if (tag === "pre" && attributes.tabindex === "0") {
      filtered.tabindex = attributes.tabindex;
    }
  }

  if (tag === "span") {
    if (typeof attributes.class === "string") {
      filtered.class = attributes.class;
    }
    if (typeof attributes.style === "string") {
      const style = filterShikiStyle(attributes.style);
      if (style) {
        filtered.style = style;
      }
    }
  }

  if (tag === "math") {
    if (typeof attributes.class === "string") {
      filtered.class = attributes.class;
    }
    if (typeof attributes.content === "string") {
      filtered.content = attributes.content;
    }
  }

  if (tag === "input") {
    if (attributes.type === "checkbox") {
      filtered.type = attributes.type;
    }
    if (typeof attributes.checked === "boolean") {
      filtered.checked = attributes.checked;
    }
    if (typeof attributes.disabled === "boolean") {
      filtered.disabled = attributes.disabled;
    }
  }

  return filtered;
}

function filterShikiStyle(style: string) {
  const declarations = style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean);
  const safeDeclarations = declarations.filter((declaration) =>
    /^(?:color|background-color):\s*(?:#[\da-fA-F]{3,8}|rgb\([^)]+\)|rgba\([^)]+\)|oklch\([^)]+\))$/
      .test(
        declaration,
      ) ||
    /^font-style:\s*(?:normal|italic)$/.test(declaration) ||
    /^font-weight:\s*(?:[1-9]00|normal|bold)$/.test(declaration) ||
    /^text-decoration:\s*(?:none|underline|line-through)$/.test(declaration)
  );

  return safeDeclarations.join(";");
}
</script>

<template>
  <Suspense>
    <Comark
      :markdown="markdown"
      :options="markdownOptions"
      :plugins="markdownPlugins"
      :components="markdownComponents"
      streaming
      class="agentaz-markdown max-w-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_.math.block]:my-2 [&_.math.block]:max-w-full [&_.math.block]:overflow-x-auto [&_a]:wrap-break-word [&_code]:wrap-break-word [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:wrap-break-word [&_ul]:my-2 [&_ul]:pl-5"
    />
    <template #fallback>
      <div
        class="agentaz-markdown max-w-full whitespace-pre-wrap wrap-break-word">
        {{ markdown }}
      </div>
    </template>
  </Suspense>
</template>
