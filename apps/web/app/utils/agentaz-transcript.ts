import type { UiBlock, UiMessage } from "../../types/protocol";
import { areSameToolBlock } from "./app.util";

export function ensureTranscriptMessage(
    messagesBySessionId: Record<string, UiMessage[]>,
    sessionId: string,
    messageId: string,
) {
    const bucket = ensureMessageBucket(messagesBySessionId, sessionId);
    let message = bucket.find(item => item.id === messageId);
    if (!message) {
        message = {
            id: messageId,
            role: "assistant",
            blocks: [],
            createdAt: Date.now(),
        };
        bucket.push(message);
    }
    return message;
}

export function ensureMessageBucket(
    messagesBySessionId: Record<string, UiMessage[]>,
    sessionId: string,
) {
    messagesBySessionId[sessionId] ??= [];
    return messagesBySessionId[sessionId];
}

/**
 * Merges a freshly loaded backend history response with still-pending local
 * user messages.
 *
 * The browser creates `local-*` user messages before the backend has persisted
 * the prompt into Pi history. Forced history refreshes can arrive during that
 * gap, especially on first-message draft materialization. In that case, a raw
 * replacement would temporarily remove the user's submitted prompt from the
 * transcript even though the assistant stream is already visible.
 *
 * Contract:
 *   - Backend history remains authoritative for all confirmed messages.
 *   - Only optimistic `local-*` user messages are preserved.
 *   - Once backend history contains a user message with the same text, the
 *     optimistic copy is considered confirmed and removed.
 *
 * @param currentMessages Messages currently rendered for the session.
 * @param historyMessages Normalized messages returned by the backend history API.
 * @returns Backend history prefixed with any still-unconfirmed local user prompts.
 */
export function mergeHistoryWithOptimisticMessages(
    currentMessages: UiMessage[] | undefined,
    historyMessages: UiMessage[],
) {
    if (!currentMessages?.length) return historyMessages;

    const historyUserTextCounts = new Map<string, number>();
    for (const message of historyMessages) {
        if (message.role !== "user") continue;
        const text = userMessageText(message);
        historyUserTextCounts.set(
            text,
            (historyUserTextCounts.get(text) ?? 0) + 1,
        );
    }

    const pendingLocalUsers: UiMessage[] = [];
    for (const message of currentMessages) {
        if (message.role !== "user" || !message.id.startsWith("local-"))
            continue;

        const text = userMessageText(message);
        const matchingHistoryCount = historyUserTextCounts.get(text) ?? 0;
        if (matchingHistoryCount > 0) {
            historyUserTextCounts.set(text, matchingHistoryCount - 1);
            continue;
        }

        pendingLocalUsers.push(message);
    }

    if (pendingLocalUsers.length === 0) return historyMessages;
    return [...pendingLocalUsers, ...historyMessages];
}

export function upsertMessage(
    messagesBySessionId: Record<string, UiMessage[]>,
    sessionId: string,
    message: UiMessage,
) {
    const bucket = ensureMessageBucket(messagesBySessionId, sessionId);
    const index = bucket.findIndex(item => item.id === message.id);
    if (index === -1) bucket.push(message);
    else bucket[index] = message;
}

/**
 * Replaces a browser-local optimistic user message with the backend-confirmed
 * canonical user message for the same submitted prompt.
 *
 * The canonical match is `clientMessageId`, not message text. Text fallback
 * remains in mergeHistoryWithOptimisticMessages() only for recovery paths where
 * the backend history predates the newer turn protocol.
 */
export function confirmOptimisticUserMessage(
    messagesBySessionId: Record<string, UiMessage[]>,
    sessionId: string,
    clientMessageId: string,
    confirmedMessage: UiMessage,
) {
    const bucket = ensureMessageBucket(messagesBySessionId, sessionId);
    const index = bucket.findIndex(item => {
        return (
            item.clientMessageId === clientMessageId ||
            (item.role === "user" &&
                item.id.startsWith("local-") &&
                item.blocks.some(
                    block =>
                        block.type === "text" &&
                        confirmedMessage.blocks.some(
                            confirmedBlock =>
                                confirmedBlock.type === "text" &&
                                confirmedBlock.text === block.text,
                        ),
                ))
        );
    });

    if (index === -1) {
        upsertMessage(messagesBySessionId, sessionId, confirmedMessage);
    } else {
        bucket[index] = confirmedMessage;
    }
}

/**
 * Removes a prompt's browser-local or backend-confirmed user message before a
 * failure recovery history refresh.
 *
 * If Pi persisted the prompt before failing, the subsequent history response
 * will restore the message. If Pi failed during preflight, this prevents the
 * optimistic/canonical placeholder from becoming an orphaned transcript entry.
 */
export function removeUserMessageByClientMessageId(
    messagesBySessionId: Record<string, UiMessage[]>,
    sessionId: string,
    clientMessageId: string,
) {
    const bucket = messagesBySessionId[sessionId];
    if (!bucket?.length) return;
    messagesBySessionId[sessionId] = bucket.filter(
        item =>
            !(
                item.role === "user" &&
                (item.clientMessageId === clientMessageId ||
                    item.id === `local-${clientMessageId}` ||
                    item.id === `user-${clientMessageId}`)
            ),
    );
}

/**
 * Creates a browser-side prompt correlation id.
 *
 * `crypto.randomUUID()` is unavailable in some non-secure browser contexts.
 * The fallback only needs local collision resistance for optimistic UI
 * reconciliation, not cryptographic secrecy.
 */
export function createClientMessageId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function upsertMessageBlock(
    messagesBySessionId: Record<string, UiMessage[]>,
    sessionId: string,
    messageId: string,
    block: UiBlock,
) {
    const message = ensureTranscriptMessage(
        messagesBySessionId,
        sessionId,
        messageId,
    );
    const index = message.blocks.findIndex(
        item => item.id === block.id || areSameToolBlock(item, block),
    );
    if (index === -1) message.blocks.push(block);
    else message.blocks[index] = block;
}

export function appendMessageBlockDelta(
    messagesBySessionId: Record<string, UiMessage[]>,
    sessionId: string,
    messageId: string,
    blockId: string,
    blockType: "text" | "thinking" | "tool_result",
    delta: string,
) {
    const message = ensureTranscriptMessage(
        messagesBySessionId,
        sessionId,
        messageId,
    );
    let block = message.blocks.find(item => item.id === blockId);
    if (!block) {
        if (blockType === "text") {
            block = { id: blockId, type: "text", text: "" };
        } else if (blockType === "thinking") {
            block = {
                id: blockId,
                type: "thinking",
                text: "",
                collapsed: true,
            };
        } else {
            block = {
                id: blockId,
                type: "tool_result",
                toolCallId: "",
                content: "",
                isError: false,
            };
        }
        message.blocks.push(block);
    }
    if (block.type === "text" || block.type === "thinking") {
        block.text += delta;
    } else if (block.type === "tool_result") {
        block.content += delta;
    }
}

/**
 * Extracts the user-visible text from a normalized message.
 *
 * Optimistic user messages and normalized history user messages both use text
 * blocks for prompts. Joining text blocks keeps matching tolerant of future
 * user-message splitting without inspecting assistant-only block types.
 */
function userMessageText(message: UiMessage) {
    return message.blocks
        .filter((block): block is Extract<UiBlock, { type: "text" }> => {
            return block.type === "text";
        })
        .map(block => block.text)
        .join("\n")
        .trim();
}
