import type {
    CompactionEntry,
    ModelRegistry,
    SessionEntry,
    SessionInfo,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS } from "@agentaz/protocol";
import type {
    ImagePayload,
    ThinkingLevel,
    UiBlock,
    UiContextUsage,
    UiMessage,
    UiModel,
    UiSessionSummary,
    UiSessionUsageStats,
} from "@agentaz/protocol";

type LooseRecord = Record<string, unknown>;

export type PersistedMessage = LooseRecord & {
    id?: string;
    role?: unknown;
    content?: unknown;
    createdAt?: unknown;
    timestamp?: unknown;
};

export type HistoryItem = PersistedMessage | CompactionEntry;

export type PiModel = NonNullable<
    ReturnType<ReturnType<typeof ModelRegistry.create>["find"]>
>;

type PiImagePayload = {
    type: "image";
    data: string;
    mimeType: string;
};

type SessionSummaryInfo =
    & SessionInfo
    & Partial<{
        file: string;
        sessionFile: string;
        sessionId: string;
        createdAt: unknown;
        updatedAt: unknown;
        mtimeMs: unknown;
        preview: string;
    }>;

/** The complete set of thinking levels exposed through the web UI. */
export const DEFAULT_THINKING_LEVELS: ThinkingLevel[] = [
    ...THINKING_LEVELS,
];

// ──────────────────────────────────────────────────────────────────────────
// Message / block normalization helpers
//
// These functions convert Pi SDK internal message representations into
// the browser-compatible UiMessage/UiBlock format used by the protocol.
// They handle multiple content shapes from different Pi SDK providers.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Converts Pi SDK message content into normalized UiBlock entries.
 *
 * Each message may contain mixed content types: text, thinking, tool_call,
 * and tool_result blocks. This function decomposes the raw content array
 * into a flat list of UiBlock objects with stable ids.
 */
export function normalizeMessages(
    messages: Array<HistoryItem>,
    options: {
        entryIdByMessageId?: Map<string, string>;
        entryIdByMessageIndex?: Map<number, string>;
        rewindEntryIdByMessageId?: Map<string, string>;
        rewindEntryIdByMessageIndex?: Map<number, string>;
    } = {},
): UiMessage[] {
    const normalized: UiMessage[] = [];
    let lastAssistant: UiMessage | undefined;

    messages.forEach((message, index) => {
        if (isCompactionEntry(message)) {
            normalized.push(normalizeCompactionEntry(message, index));
            lastAssistant = undefined;
            return;
        }

        // Tool result messages are attached to the preceding assistant message.
        // If there is no preceding assistant message, create a synthetic one.
        if (isToolResultMessage(message)) {
            const target = lastAssistant ??
                createSyntheticAssistantMessage(message, index);
            appendToolResultToMessage(target, message, index);
            if (!lastAssistant) {
                normalized.push(target);
                lastAssistant = target;
            }
            return;
        }

        // Regular message: determine id, role, and blocks once, then either push
        // a new message or merge assistant blocks into the current assistant turn.
        const messageRecord = asRecord(message) as PersistedMessage;
        const messageId = messageRecord.id ?? `history-${index}`;
        const role = normalizeRole(messageRecord.role);
        const uiMessage: UiMessage = {
            id: messageId,
            entryId:
                options.entryIdByMessageId?.get(String(messageRecord.id)) ??
                    options.entryIdByMessageIndex?.get(index),
            rewindEntryId: options.rewindEntryIdByMessageId?.get(
                String(messageRecord.id),
            ) ??
                options.rewindEntryIdByMessageIndex?.get(index),
            role,
            blocks: normalizeContent(
                messageRecord.content ?? message,
                messageId,
            ),
            createdAt: toTimestamp(
                messageRecord.createdAt ?? messageRecord.timestamp,
            ),
        };

        // Streaming presents consecutive Pi SDK assistant messages as one
        // browser-visible assistant turn. Mirror that shape when loading history
        // so reloads do not split a single turn into multiple assistant bubbles.
        if (role === "assistant") {
            if (lastAssistant) {
                lastAssistant.blocks.push(...uiMessage.blocks);
                return;
            }

            normalized.push(uiMessage);
            lastAssistant = uiMessage;
            return;
        }

        // User/system messages are turn boundaries. The next assistant message
        // should start a new browser-visible assistant turn.
        normalized.push(uiMessage);
        lastAssistant = undefined;
    });

    return normalized;
}

function isCompactionEntry(value: HistoryItem): value is CompactionEntry {
    return asRecord(value).type === "compaction";
}

/** Converts a Pi compaction entry into a durable transcript marker. */
function normalizeCompactionEntry(
    entry: CompactionEntry,
    index: number,
): UiMessage {
    const messageId = `compaction-${entry.id ?? index}`;
    const tokensBefore = typeof entry.tokensBefore === "number"
        ? entry.tokensBefore.toLocaleString()
        : "unknown";
    return {
        id: messageId,
        entryId: entry.id,
        role: "system",
        blocks: [
            {
                id: `${messageId}:text`,
                type: "text",
                text:
                    `Context compacted. Previous context: ${tokensBefore} tokens.`,
            },
        ],
        createdAt: toTimestamp(entry.timestamp),
    };
}

/** Checks if a message is a tool result (role = "toolResult" or "tool"). */
function isToolResultMessage(message: unknown) {
    const record = asRecord(message);
    return record.role === "toolResult" || record.role === "tool";
}

/** Creates a synthetic assistant message to host orphan tool results. */
function createSyntheticAssistantMessage(
    message: unknown,
    index: number,
): UiMessage {
    const record = asRecord(message);
    const messageId = `history-tool-host-${
        stringOrUndefined(record.id) ?? index
    }`;
    return {
        id: messageId,
        role: "assistant",
        blocks: [],
        createdAt: numberOrUndefined(record.createdAt) ??
            numberOrUndefined(record.timestamp),
    };
}

/**
 * Appends a tool_result block to an assistant message, creating a
 * matching tool_call block if one doesn't already exist.
 */
function appendToolResultToMessage(
    message: UiMessage,
    toolResult: unknown,
    index: number,
) {
    const toolResultRecord = asRecord(toolResult);
    const toolCallId = extractToolCallId(toolResult) ?? `tool-${index}`;
    const toolName = stringOrUndefined(toolResultRecord.toolName) ??
        stringOrUndefined(toolResultRecord.name) ??
        stringOrUndefined(toolResultRecord.tool) ?? "tool";
    const callBlockId = `${message.id}:tool:${toolCallId}:call`;
    const resultBlockId = `${message.id}:tool:${toolCallId}:result`;

    // Try to find an existing tool_call block to update.
    const existingCall = findToolCallBlock(message, toolCallId);

    if (existingCall) {
        existingCall.id = callBlockId;
        existingCall.toolName = existingCall.toolName || toolName;
        existingCall.input ??= extractToolInput(toolResult);
        existingCall.status = toolResultRecord.isError ? "error" : "completed";
    }
    else {
        // No existing call block — create one.
        message.blocks.push({
            id: callBlockId,
            type: "tool_call",
            toolCallId,
            toolName,
            input: extractToolInput(toolResult),
            status: toolResultRecord.isError ? "error" : "completed",
        });
    }

    // Create or update the result block.
    const resultBlock: UiBlock = {
        id: resultBlockId,
        type: "tool_result",
        toolCallId,
        content: normalizeToolResultContent(toolResult),
        isError: booleanOrUndefined(toolResultRecord.isError) ??
            Boolean(toolResultRecord.error),
    };
    const existingIndex = message.blocks.findIndex(
        (block) => block.id === resultBlockId,
    );
    if (existingIndex === -1) {
        message.blocks.push(resultBlock);
    }
    else {
        message.blocks[existingIndex] = resultBlock;
    }
}

/** Normalizes tool result content into a displayable string. */
function normalizeToolResultContent(toolResult: unknown) {
    const record = asRecord(toolResult);
    const content = record.content ??
        record.result ??
        record.output ??
        record.error ??
        toolResult;
    return flattenText(content);
}

/** Maps Pi SDK role strings to the protocol's normalized role values. */
function normalizeRole(role: unknown): UiMessage["role"] {
    if (
        role === "user" ||
        role === "assistant" ||
        role === "tool" ||
        role === "system"
    ) {
        return role;
    }
    if (role === "toolResult") {
        return "tool";
    }
    return "system";
}

/**
 * Converts Pi SDK message content into normalized UiBlock entries.
 *
 * Handles three content shapes:
 *   1. String content → single text block.
 *   2. Array of content parts → one UiBlock per recognized part.
 *   3. Unknown shape → JSON-serialized text block.
 */
function normalizeContent(content: unknown, messageId: string): UiBlock[] {
    if (typeof content === "string") {
        return [{ id: `${messageId}:text:0`, type: "text", text: content }];
    }
    if (Array.isArray(content)) {
        const blocks = content
            .map((part, index) => normalizeContentPart(part, messageId, index))
            .filter(Boolean) as UiBlock[];
        // Ensure at least one block exists for display purposes.
        if (blocks.length === 0) {
            return [{ id: `${messageId}:text:0`, type: "text", text: "" }];
        }
        return blocks;
    }
    return [
        {
            id: `${messageId}:text:0`,
            type: "text",
            text: flattenText(content),
        },
    ];
}

/**
 * Converts a single content part into a UiBlock, or returns null for
 * unrecognized shapes.
 */
function normalizeContentPart(
    part: unknown,
    messageId: string,
    index: number,
): UiBlock | null {
    // Plain string part → text block.
    if (typeof part === "string") {
        return { id: `${messageId}:text:${index}`, type: "text", text: part };
    }

    const record = asRecord(part);
    const type = record.type;

    if (type === "text") {
        return {
            id: stringOrUndefined(record.id) ?? `${messageId}:text:${index}`,
            type: "text",
            text: stringOrEmpty(record.text),
        };
    }

    if (type === "thinking") {
        return {
            id: stringOrUndefined(record.id) ??
                `${messageId}:thinking:${index}`,
            type: "thinking",
            text: stringOrUndefined(record.thinking) ??
                stringOrEmpty(record.text),
            collapsed: booleanOrUndefined(record.collapsed) ?? true,
        };
    }

    // Handle both "tool_call" and "toolCall" for cross-provider compatibility.
    if (type === "tool_call" || type === "toolCall") {
        const toolCallId = extractToolCallId(part) ?? `tool-${index}`;
        return {
            id: `${messageId}:tool:${toolCallId}:call`,
            type: "tool_call",
            toolCallId,
            toolName: stringOrUndefined(record.toolName) ??
                stringOrUndefined(record.name) ??
                stringOrUndefined(record.tool) ?? "",
            input: extractToolInput(part),
            status: normalizeToolStatus(record.status),
        };
    }

    if (type === "tool_result" || type === "toolResult") {
        const toolCallId = extractToolCallId(part) ?? `tool-${index}`;
        return {
            id: `${messageId}:tool:${toolCallId}:result`,
            type: "tool_result",
            toolCallId,
            content: typeof record.content === "string"
                ? record.content
                : flattenText(record.content),
            isError: booleanOrUndefined(record.isError) ?? false,
        };
    }

    // Fallback: if the part has a text property, treat it as text.
    if (typeof record.text === "string" && record.text.length > 0) {
        return {
            id: stringOrUndefined(record.id) ?? `${messageId}:text:${index}`,
            type: "text",
            text: record.text,
        };
    }

    return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Utility helpers exported for use by pi-session-workspace and other modules
// ──────────────────────────────────────────────────────────────────────────

export function asRecord(value: unknown): LooseRecord {
    return value && typeof value === "object" ? value as LooseRecord : {};
}

export function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

export function stringOrEmpty(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function numberOrUndefined(value: unknown): number | undefined {
    return typeof value === "number" ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function normalizeToolStatus(
    value: unknown,
): Extract<UiBlock, { type: "tool_call" }>["status"] {
    return value === "pending" || value === "running" ||
            value === "completed" || value === "error" || value === "blocked"
        ? value
        : "completed";
}

/**
 * Extracts a tool call id from any value by probing known field names.
 * Pi SDK events and messages from different providers use different field
 * shapes — this function checks them all.
 */
export function extractToolCallId(value: unknown): string | undefined {
    const record = asRecord(value);
    const toolCall = asRecord(record.toolCall);
    const call = asRecord(record.call);
    const execution = asRecord(record.execution);
    const id = record.toolCallId ??
        record.tool_call_id ??
        record.callID ??
        record.callId ??
        record.toolUseId ??
        record.tool_use_id ??
        toolCall.id ??
        toolCall.toolCallId ??
        call.id ??
        execution.toolCallId ??
        execution.id ??
        record.id;
    return id === undefined || id === null || id === ""
        ? undefined
        : String(id);
}

/**
 * Extracts tool input/arguments from any value by probing known field names.
 */
export function extractToolInput(value: unknown): unknown {
    const record = asRecord(value);
    const toolCall = asRecord(record.toolCall);
    return (
        record.input ??
            record.args ??
            record.params ??
            record.arguments ??
            record.toolInput ??
            toolCall.arguments
    );
}

/** Finds a tool_call block within a message by toolCallId. */
export function findToolCallBlock(message: UiMessage, toolCallId: string) {
    return message.blocks.find(
        (block): block is Extract<UiBlock, { type: "tool_call" }> =>
            block.type === "tool_call" && block.toolCallId === toolCallId,
    );
}

/** Checks whether two UiBlocks represent the same logical tool entry. */
export function areSameToolBlock(left: UiBlock, right: UiBlock) {
    if (left.type === "tool_call" && right.type === "tool_call") {
        return left.toolCallId === right.toolCallId;
    }
    if (left.type === "tool_result" && right.type === "tool_result") {
        return left.toolCallId === right.toolCallId;
    }
    return false;
}

/**
 * Flattens arbitrary content into a displayable string.
 * Recursively joins array elements and stringifies objects.
 */
export function flattenText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((
                part,
            ) => (typeof part === "string" ? part : (part?.text ?? "")))
            .join("");
    }
    return JSON.stringify(content);
}

/** Converts a timestamp-like value to a numeric epoch milliseconds. */
export function toTimestamp(value: unknown): number | undefined {
    if (typeof value === "number") {
        return value;
    }
    if (value instanceof Date) {
        return value.getTime();
    }
    if (typeof value === "string") {
        const timestamp = Date.parse(value);
        return Number.isNaN(timestamp) ? undefined : timestamp;
    }
    return undefined;
}

/** Summarizes tool result content for display, truncating at 500 characters. */
export function summarizeToolResult(result: unknown) {
    const text = flattenText(result);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
/** Converts ImagePayload to Pi SDK image format (base64 media). */
export function toPiImages(
    images?: ImagePayload[],
): PiImagePayload[] | undefined {
    return images?.map((image) => ({
        type: "image",
        data: image.data,
        mimeType: image.mediaType,
    }));
}

/** Converts Pi SDK session info to the UI session summary format. */
export function toUiSessionSummary(info: SessionSummaryInfo): UiSessionSummary {
    return {
        file: info.path ?? info.file ?? info.sessionFile,
        sessionId: info.id ?? info.sessionId,
        name: info.name,
        createdAt: toTimestamp(info.created ?? info.createdAt),
        updatedAt: toTimestamp(
            info.modified ?? info.updatedAt ?? info.mtimeMs,
        ),
        firstMessage: info.firstMessage ?? info.preview,
    };
}

/** Converts Pi SDK model info to the UI model format. */
export function toUiModel(model: PiModel): UiModel {
    return {
        provider: model.provider,
        id: model.id,
        name: model.name,
        availableThinkingLevels: supportedThinkingLevels(model),
    };
}

/** Normalizes a thinking level value, defaulting to "off" for unknown values. */
export function normalizeThinkingLevel(level: unknown): ThinkingLevel {
    return DEFAULT_THINKING_LEVELS.includes(level as ThinkingLevel)
        ? (level as ThinkingLevel)
        : "off";
}

/** Returns supported thinking levels for a model based on its reasoning capability. */
export function supportedThinkingLevels(model: PiModel): ThinkingLevel[] {
    if (!model?.reasoning) {
        return ["off"];
    }
    return DEFAULT_THINKING_LEVELS.filter((level) => {
        // If the model has a thinkingLevelMap, check if this level is mapped.
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null) {
            return false;
        }
        // Pi only advertises its two highest levels through explicit mappings.
        if (level === "xhigh" || level === "max") {
            return mapped !== undefined;
        }
        return true;
    });
}

/** Extracts session metadata from a SessionManager for UI display. */
export function summarizeSessionManager(
    sessionManager: SessionManager,
): Omit<UiSessionSummary, "file"> {
    const header = sessionManager.getHeader();
    const entries = sessionManager.getEntries();
    const latestEntry = entries.at(-1);
    return {
        name: sessionManager.getSessionName(),
        createdAt: toTimestamp(header?.timestamp),
        updatedAt: toTimestamp(latestEntry?.timestamp ?? header?.timestamp),
        firstMessage: firstUserMessage(entries),
    };
}

/** Finds the text of the first user message in session entries. */
export function firstUserMessage(entries: SessionEntry[]) {
    for (const entry of entries) {
        const message = entry?.type === "message" ? entry.message : undefined;
        if (message?.role !== "user") {
            continue;
        }
        const text = flattenText(message.content);
        if (text) {
            return text;
        }
    }
    return undefined;
}

/** Normalizes Pi SDK ContextUsage to protocol UiContextUsage. */
export function normalizeContextUsage(
    raw:
        | {
            tokens: number | null;
            contextWindow: number;
            percent: number | null;
        }
        | undefined,
): UiContextUsage | undefined {
    if (!raw) {
        return undefined;
    }
    return {
        tokens: raw.tokens,
        contextWindow: raw.contextWindow,
        percent: raw.percent,
    };
}

/** Summarizes cumulative usage stats from the current persisted branch. */
export function summarizeUsageStatsFromEntries(
    entries: SessionEntry[],
): UiSessionUsageStats {
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolResults = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;

    for (const entry of entries) {
        if (entry?.type !== "message") {
            continue;
        }

        const message = asRecord(entry.message);
        const role = message.role;
        if (role === "user") {
            userMessages += 1;
        }
        else if (role === "assistant") {
            assistantMessages += 1;
            toolCalls += countToolCalls(message.content);

            const usage = asRecord(message.usage);
            input += numberOrZero(usage.input);
            output += numberOrZero(usage.output);
            cacheRead += numberOrZero(usage.cacheRead);
            cacheWrite += numberOrZero(usage.cacheWrite);
            cost += numberOrZero(asRecord(usage.cost).total);
        }
        else if (role === "toolResult" || role === "tool") {
            toolResults += 1;
        }
    }

    return {
        userMessages,
        assistantMessages,
        toolCalls,
        toolResults,
        totalMessages: userMessages + assistantMessages + toolResults,
        tokens: {
            input,
            output,
            cacheRead,
            cacheWrite,
            total: input + output + cacheRead + cacheWrite,
        },
        cost,
    };
}

/** Counts tool-call content parts inside an assistant message. */
function countToolCalls(content: unknown) {
    if (!Array.isArray(content)) {
        return 0;
    }
    return content.filter((part) => {
        const type = asRecord(part).type;
        return type === "toolCall" || type === "tool_call";
    }).length;
}

/** Returns finite numbers only; malformed historical usage counts as zero. */
function numberOrZero(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
