import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ServerEvent, UiMessage } from "@agentaz/protocol";
import { PiSessionController } from "../../src/pi/session-controller.ts";

type LiveTurnTestController = {
    liveTurnMessages: Map<string, UiMessage>;
    currentAssistantMessageId: string;
    startPromptTurn(
        text: string,
        turn: { turnId: string; clientMessageId: string },
    ): void;
    onSessionEvent(event: unknown): void;
    getHistory(): { messages: UiMessage[] };
};

/**
 * Purpose: Verify the controller retains only mutable state needed for the active
 * assistant turn while preserving multi-message/tool ordering and final SSE recovery.
 * Expect: Text/tool blocks merge, final upserts precede cleanup, and turns never accumulate.
 * Method: Emit turn_started, text, tool start/end, another assistant segment, and
 * agent_end twice; inspect block order, final-upsert counts, IDs, and map size at boundaries.
 */
Deno.test("live projection retains only the active assistant turn", () => {
    const events: ServerEvent[] = [];
    const controller = liveTurnController([], events);

    controller.startPromptTurn("question one", {
        turnId: "turn-1",
        clientMessageId: "client-1",
    });
    assert.equal(controller.liveTurnMessages.size, 0);
    assert.equal(events.at(-1)?.type, "turn_started");

    controller.onSessionEvent({
        type: "message_start",
        message: { role: "assistant" },
    });
    controller.onSessionEvent(messageDelta("before tool"));
    controller.onSessionEvent({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        input: { path: "README.md" },
    });
    controller.onSessionEvent({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "tool output" }] },
    });
    controller.onSessionEvent({
        type: "message_start",
        message: { role: "assistant" },
    });
    controller.onSessionEvent(messageDelta("after tool"));

    const firstAssistantId = controller.currentAssistantMessageId;
    assert.equal(controller.liveTurnMessages.size, 1);
    assert.deepEqual(
        controller.liveTurnMessages.get(firstAssistantId)?.blocks.map(
            (block) => block.type,
        ),
        ["text", "tool_call", "tool_result", "text"],
    );

    controller.onSessionEvent({ type: "agent_end", messages: [] });

    assert.equal(controller.liveTurnMessages.size, 0);
    const firstFinal = events.findLast(
        (event) => event.type === "message_upsert",
    );
    assert.equal(firstFinal?.type, "message_upsert");
    if (firstFinal?.type === "message_upsert") {
        assert.equal(firstFinal.message.id, firstAssistantId);
        assert.deepEqual(
            firstFinal.message.blocks.map((block) => block.type),
            ["text", "tool_call", "tool_result", "text"],
        );
    }
    assert.equal(messageUpsertCount(events, firstAssistantId), 2);

    controller.startPromptTurn("question two", {
        turnId: "turn-2",
        clientMessageId: "client-2",
    });
    controller.onSessionEvent(messageDelta("second answer"));
    const secondAssistantId = controller.currentAssistantMessageId;
    assert.notEqual(secondAssistantId, firstAssistantId);
    assert.equal(controller.liveTurnMessages.size, 1);
    assert.ok(!controller.liveTurnMessages.has(firstAssistantId));

    controller.onSessionEvent({ type: "agent_end", messages: [] });
    assert.equal(controller.liveTurnMessages.size, 0);
    const secondFinal = events.findLast(
        (event) => event.type === "message_upsert",
    );
    assert.equal(secondFinal?.type, "message_upsert");
    if (secondFinal?.type === "message_upsert") {
        assert.equal(secondFinal.message.id, secondAssistantId);
        assert.equal(secondFinal.message.blocks.length, 1);
    }
    assert.equal(messageUpsertCount(events, secondAssistantId), 2);
});

/**
 * Purpose: Verify provider edge events preserve thinking and anonymous tool identity
 * while accumulated partial results are forwarded as deltas exactly once.
 * Expect: One anonymous call owns error/result blocks and tool-result deltas are abc then def.
 * Method: Emit thinking, anonymous start, two accumulated updates, and an error end.
 */
Deno.test("live projection streams thinking and anonymous tool result deltas", () => {
    const events: ServerEvent[] = [];
    const controller = liveTurnController([], events);
    controller.startPromptTurn("run it", {
        turnId: "turn-1",
        clientMessageId: "client-1",
    });

    controller.onSessionEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "reason" },
    });
    controller.onSessionEvent({
        type: "tool_start",
        name: "bash",
        input: { command: "echo" },
    });
    controller.onSessionEvent({
        type: "tool_update",
        name: "bash",
        partialResult: { content: [{ type: "text", text: "abc" }] },
    });
    controller.onSessionEvent({
        type: "tool_update",
        name: "bash",
        partialResult: { content: [{ type: "text", text: "abcdef" }] },
    });
    controller.onSessionEvent({
        type: "tool_end",
        name: "bash",
        error: "denied",
        isError: true,
    });

    const message = controller.liveTurnMessages.get(
        controller.currentAssistantMessageId,
    );
    assert.ok(message);
    assert.deepEqual(message.blocks.map((block) => block.type), [
        "thinking",
        "tool_call",
        "tool_result",
    ]);
    const call = message.blocks.find((block) => block.type === "tool_call");
    const result = message.blocks.find((block) => block.type === "tool_result");
    assert.equal(call?.toolCallId, "anonymous-1");
    assert.equal(call?.status, "error");
    assert.equal(result?.toolCallId, "anonymous-1");
    assert.equal(result?.isError, true);
    assert.equal(result?.content, "denied");

    assert.deepEqual(
        events.filter((event) =>
            event.type === "message_block_delta" &&
            event.blockType === "tool_result"
        ).map((event) =>
            event.type === "message_block_delta" ? event.delta : ""
        ),
        ["abc", "def"],
    );
    assert.ok(events.some((event) =>
        event.type === "message_block_delta" &&
        event.blockType === "thinking" && event.delta === "reason"
    ));
});

/**
 * Purpose: Verify HTTP history remains authoritative and cannot accidentally expose
 * transient or stale messages retained only by the realtime projection.
 * Expect: History contains only SessionManager entries and excludes a live-only message.
 * Method: Give the fake SessionManager persisted user/assistant entries, inject a
 * conflicting live-only assistant into the map, call getHistory, and compare returned IDs.
 */
Deno.test("history projection is independent from live turn messages", () => {
    const entries = [
        messageEntry("history-user", "user", "persisted question"),
        messageEntry("history-assistant", "assistant", "persisted answer"),
    ];
    const controller = liveTurnController(entries, []);
    controller.liveTurnMessages.set("live-only", {
        id: "live-only",
        role: "assistant",
        blocks: [{ id: "live:text:0", type: "text", text: "not persisted" }],
    });

    const history = controller.getHistory();

    assert.deepEqual(
        history.messages.map((message) => message.id),
        ["history-user", "history-assistant"],
    );
    assert.ok(!history.messages.some((message) => message.id === "live-only"));
});

function liveTurnController(
    entries: SessionEntry[],
    events: ServerEvent[],
) {
    const session = {
        sessionId: "session-a",
        isStreaming: false,
        pendingMessageCount: 0,
        getContextUsage: () => undefined,
    };
    const controller = Object.create(
        PiSessionController.prototype,
    ) as LiveTurnTestController;
    Object.assign(controller, {
        sessionResult: { session },
        sessionManager: {
            getBranch: () => entries,
        },
        host: {
            emit: (event: ServerEvent) => events.push(event),
        },
        liveTurnMessages: new Map<string, UiMessage>(),
        currentAssistantMessageId: "assistant-turn-1",
        currentTextBlockId: undefined,
        currentThinkingBlockId: undefined,
        toolBlocks: new Map(),
        toolResultEmittedLength: new Map(),
        anonymousToolCallCounter: 0,
        anonymousToolCallId: undefined,
        currentToolRequestAnchor: undefined,
        pendingSettings: {},
        transcriptRevision: 0,
        compacting: false,
        disposing: false,
        disposed: false,
    });
    return controller;
}

function messageDelta(delta: string) {
    return {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta },
    };
}

function messageUpsertCount(events: ServerEvent[], messageId: string) {
    return events.filter(
        (event) =>
            event.type === "message_upsert" && event.message.id === messageId,
    ).length;
}

function messageEntry(id: string, role: string, content: string): SessionEntry {
    return {
        type: "message",
        id,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { id, role, content, timestamp: 0 },
    } as unknown as SessionEntry;
}
