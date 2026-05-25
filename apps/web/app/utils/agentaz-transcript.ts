import type { UiBlock, UiMessage } from "../../types/protocol";
import { areSameToolBlock } from "./app.util";

export function ensureTranscriptMessage(
  messagesBySessionId: Record<string, UiMessage[]>,
  sessionId: string,
  messageId: string,
) {
  const bucket = ensureMessageBucket(messagesBySessionId, sessionId);
  let message = bucket.find((item) => item.id === messageId);
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

export function upsertMessage(
  messagesBySessionId: Record<string, UiMessage[]>,
  sessionId: string,
  message: UiMessage,
) {
  const bucket = ensureMessageBucket(messagesBySessionId, sessionId);
  const index = bucket.findIndex((item) => item.id === message.id);
  if (index === -1) bucket.push(message);
  else bucket[index] = message;
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
    (item) => item.id === block.id || areSameToolBlock(item, block),
  );
  if (index === -1) message.blocks.push(block);
  else message.blocks[index] = block;
}

export function appendMessageBlockDelta(
  messagesBySessionId: Record<string, UiMessage[]>,
  sessionId: string,
  messageId: string,
  blockId: string,
  blockType: "text" | "thinking",
  delta: string,
) {
  const message = ensureTranscriptMessage(
    messagesBySessionId,
    sessionId,
    messageId,
  );
  let block = message.blocks.find((item) => item.id === blockId);
  if (!block) {
    block =
      blockType === "text"
        ? { id: blockId, type: "text", text: "" }
        : { id: blockId, type: "thinking", text: "", collapsed: true };
    message.blocks.push(block);
  }
  if (block.type === "text" || block.type === "thinking") {
    block.text += delta;
  }
}
