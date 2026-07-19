import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UiBlock } from "@agentaz/protocol";
import {
    areSameToolBlock,
    extractToolCallId,
    extractToolInput,
    flattenText,
    normalizeMessages,
    normalizeThinkingLevel,
    summarizeToolResult,
    summarizeUsageStatsFromEntries,
    supportedThinkingLevels,
    toPiImages,
    toTimestamp,
} from "../../src/pi/session-controller.ts";

type HistoryItems = Parameters<typeof normalizeMessages>[0];

/**
 * Purpose: Verify persisted provider messages with mixed content become the complete
 * browser protocol shape required for rendering and fork/revert anchoring.
 * Expect: Text, thinking, and tool blocks retain content, IDs, timestamps, and entry metadata.
 * Method: Supply user text plus assistant text/thinking/tool-call parts with explicit
 * message-to-entry maps, normalize them, then inspect every message and block field.
 */
Deno.test("normalizeMessages preserves mixed content and history metadata", () => {
    const messages = normalizeMessages(
        [
            {
                id: "user-1",
                role: "user",
                content: "hello",
                createdAt: "2026-01-02T03:04:05Z",
            },
            {
                id: "assistant-1",
                role: "assistant",
                content: [
                    { type: "text", text: "answer" },
                    {
                        type: "thinking",
                        thinking: "reasoning",
                        collapsed: false,
                    },
                    {
                        type: "toolCall",
                        toolCallId: "call-1",
                        name: "read",
                        arguments: { path: "README.md" },
                        status: "running",
                    },
                ],
            },
        ] as HistoryItems,
        {
            entryIdByMessageId: new Map([
                ["user-1", "entry-user"],
                ["assistant-1", "entry-assistant"],
            ]),
            rewindEntryIdByMessageId: new Map([
                ["assistant-1", "entry-user"],
            ]),
        },
    );

    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], {
        id: "user-1",
        entryId: "entry-user",
        rewindEntryId: undefined,
        role: "user",
        blocks: [{ id: "user-1:text:0", type: "text", text: "hello" }],
        createdAt: Date.parse("2026-01-02T03:04:05Z"),
    });
    assert.equal(messages[1].entryId, "entry-assistant");
    assert.equal(messages[1].rewindEntryId, "entry-user");
    assert.deepEqual(messages[1].blocks, [
        { id: "assistant-1:text:0", type: "text", text: "answer" },
        {
            id: "assistant-1:thinking:1",
            type: "thinking",
            text: "reasoning",
            collapsed: false,
        },
        {
            id: "assistant-1:tool:call-1:call",
            type: "tool_call",
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "README.md" },
            status: "running",
        },
    ]);
});

/**
 * Purpose: Verify reload preserves the live UI invariant that multiple Pi assistant
 * messages and their tool result form one ordered browser-visible turn.
 * Expect: Assistant/tool-result/assistant entries merge into ordered completed tool blocks.
 * Method: Normalize user → assistant tool call → toolResult → assistant text, then
 * assert one assistant message owns the completed call/result and trailing text blocks.
 */
Deno.test("normalizeMessages groups assistant turns across tool results", () => {
    const messages = normalizeMessages([
        { id: "user", role: "user", content: "do it" },
        {
            id: "assistant-a",
            role: "assistant",
            content: [{
                type: "tool_call",
                toolCallId: "call-1",
                toolName: "bash",
                input: { command: "pwd" },
                status: "running",
            }],
        },
        {
            id: "result",
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: "/tmp",
        },
        { id: "assistant-b", role: "assistant", content: "done" },
    ] as HistoryItems);

    assert.equal(messages.length, 2);
    assert.equal(messages[1].id, "assistant-a");
    assert.deepEqual(messages[1].blocks, [
        {
            id: "assistant-a:tool:call-1:call",
            type: "tool_call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "pwd" },
            status: "completed",
        },
        {
            id: "assistant-a:tool:call-1:result",
            type: "tool_result",
            toolCallId: "call-1",
            content: "/tmp",
            isError: false,
        },
        {
            id: "assistant-b:text:0",
            type: "text",
            text: "done",
        },
    ]);
});

/**
 * Purpose: Verify incomplete/legacy JSONL containing a tool result without its
 * assistant call still projects into valid, visible, and diagnosable UI blocks.
 * Expect: A synthetic assistant host contains matching error call and result blocks.
 * Method: Feed one error tool entry using alternate call/name fields, then assert
 * creation of a timestamped synthetic assistant with matching call/result IDs.
 */
Deno.test("normalizeMessages creates a host for orphan error tool results", () => {
    const [message] = normalizeMessages([{
        id: "result-1",
        role: "tool",
        callId: "call-9",
        name: "write",
        error: "denied",
        isError: true,
        timestamp: 42,
    }] as HistoryItems);

    assert.equal(message.id, "history-tool-host-result-1");
    assert.equal(message.role, "assistant");
    assert.equal(message.createdAt, 42);
    assert.deepEqual(message.blocks, [
        {
            id: `${message.id}:tool:call-9:call`,
            type: "tool_call",
            toolCallId: "call-9",
            toolName: "write",
            input: undefined,
            status: "error",
        },
        {
            id: `${message.id}:tool:call-9:result`,
            type: "tool_result",
            toolCallId: "call-9",
            content: "denied",
            isError: true,
        },
    ]);
});

/**
 * Purpose: Verify compaction and non-assistant messages terminate assistant grouping,
 * preventing persisted turns across context or role boundaries from sharing a bubble.
 * Expect: Compaction, user, and unknown/system entries reset assistant grouping.
 * Method: Normalize assistant → compaction → assistant → unknown-role entries and
 * inspect message count, compaction text, surviving assistant ID, and system fallback.
 */
Deno.test("normalizeMessages treats compaction and user messages as turn boundaries", () => {
    const messages = normalizeMessages([
        { id: "a", role: "assistant", content: "before" },
        {
            type: "compaction",
            id: "compact-1",
            tokensBefore: 1200,
            timestamp: "2026-02-01T00:00:00Z",
        },
        { id: "b", role: "assistant", content: "after" },
        { id: "unknown", role: "alien", content: { value: 1 } },
    ] as HistoryItems);

    assert.equal(messages.length, 4);
    assert.equal(messages[1].id, "compaction-compact-1");
    assert.equal(
        messages[1].blocks[0].type === "text" ? messages[1].blocks[0].text : "",
        "Context compacted. Previous context: 1,200 tokens.",
    );
    assert.equal(messages[2].id, "b");
    assert.equal(messages[3].role, "system");
    assert.equal(
        messages[3].blocks[0].type === "text" ? messages[3].blocks[0].text : "",
        '{"value":1}',
    );
});

/**
 * Purpose: Verify compatibility helpers absorb known provider/SDK field variants so
 * event forwarding does not leak camelCase, snake_case, or nested transport differences.
 * Expect: IDs, inputs, flattened text, result truncation, and images use stable forms.
 * Method: Table-drive tool IDs and inputs across alternate shapes, then exercise text
 * flattening, 500-character result summarization, and browser-to-Pi image conversion.
 */
Deno.test("tool and content helpers normalize provider variants", () => {
    const idCases: Array<[unknown, string | undefined]> = [
        [{ tool_call_id: "snake" }, "snake"],
        [{ toolCall: { id: "nested" } }, "nested"],
        [{ execution: { toolCallId: 17 } }, "17"],
        [{ id: "" }, undefined],
    ];
    for (const [input, expected] of idCases) {
        assert.equal(extractToolCallId(input), expected);
    }

    assert.deepEqual(extractToolInput({ params: { n: 1 } }), { n: 1 });
    assert.deepEqual(
        extractToolInput({ toolCall: { arguments: { n: 2 } } }),
        { n: 2 },
    );
    assert.equal(flattenText(["a", { text: "b" }, { ignored: true }]), "ab");
    assert.equal(summarizeToolResult("x".repeat(501)).length, 503);
    assert.deepEqual(toPiImages([{ mediaType: "image/png", data: "abc" }]), [
        { type: "image", mimeType: "image/png", data: "abc" },
    ]);
});

/**
 * Purpose: Verify malformed model/timestamp data and regenerated block IDs cannot
 * produce unsupported UI state or duplicate logical tool blocks.
 * Expect: Invalid values normalize predictably and equivalent tool calls match by call ID.
 * Method: Normalize valid/invalid thinking levels, derive capability lists for two
 * model shapes, convert timestamps, and compare tool blocks sharing a toolCallId.
 */
Deno.test("model, timestamp, and block helpers enforce stable defaults", () => {
    assert.equal(normalizeThinkingLevel("high"), "high");
    assert.equal(normalizeThinkingLevel("invalid"), "off");
    assert.deepEqual(
        supportedThinkingLevels(
            {
                reasoning: false,
            } as Parameters<typeof supportedThinkingLevels>[0],
        ),
        ["off"],
    );
    assert.deepEqual(
        supportedThinkingLevels(
            {
                reasoning: true,
                thinkingLevelMap: { low: null, xhigh: "xhigh" },
            } as Parameters<typeof supportedThinkingLevels>[0],
        ),
        ["off", "minimal", "medium", "high", "xhigh"],
    );
    assert.equal(toTimestamp(new Date(123)), 123);
    assert.equal(toTimestamp("not-a-date"), undefined);

    const callA: UiBlock = {
        id: "a",
        type: "tool_call",
        toolCallId: "call",
        toolName: "read",
        input: {},
        status: "running",
    };
    const callB: UiBlock = { ...callA, id: "b" };
    const result: UiBlock = {
        id: "r",
        type: "tool_result",
        toolCallId: "call",
        content: "ok",
    };
    assert.equal(areSameToolBlock(callA, callB), true);
    assert.equal(areSameToolBlock(callA, result), false);
});

/**
 * Purpose: Verify sidebar usage totals remain finite and accurate when persisted SDK
 * messages contain partial usage data, malformed numbers, and multiple tool-call shapes.
 * Expect: Valid counts/tokens/cost are summed while malformed cache-write usage becomes zero.
 * Method: Build three SessionEntries with mixed tool block spellings and NaN cache
 * writes, summarize the branch, then assert every count, token bucket, and cost total.
 */
Deno.test("summarizeUsageStatsFromEntries ignores malformed usage", () => {
    const entries = [
        messageEntry("user", "hello"),
        messageEntry("assistant", [
            { type: "toolCall" },
            { type: "tool_call" },
        ], {
            input: 10,
            output: 4,
            cacheRead: 3,
            cacheWrite: Number.NaN,
            cost: { total: 0.25 },
        }),
        messageEntry("toolResult", "ok"),
    ];

    assert.deepEqual(summarizeUsageStatsFromEntries(entries), {
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 2,
        toolResults: 1,
        totalMessages: 3,
        tokens: {
            input: 10,
            output: 4,
            cacheRead: 3,
            cacheWrite: 0,
            total: 17,
        },
        cost: 0.25,
    });
});

function messageEntry(
    role: string,
    content: unknown,
    usage?: unknown,
): SessionEntry {
    return {
        type: "message",
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role, content, usage },
    } as unknown as SessionEntry;
}
