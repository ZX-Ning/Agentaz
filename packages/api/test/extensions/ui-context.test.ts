import assert from "node:assert/strict";
import type { ServerEvent } from "@agentaz/protocol";
import { WebExtensionUIContext } from "../../src/extensions/ui-context.ts";

/**
 * Purpose: Verify browser-backed extension requests preserve anchors, pending
 * snapshots, response values, and kind isolation across the complete lifecycle.
 * Expect: Matching responses settle requests; a mismatched response leaves the request pending.
 * Method: Issue select/input/confirm requests, inspect emitted events, and resolve each by id.
 */
Deno.test("WebExtensionUIContext resolves anchored requests by matching kind", async () => {
    const events: ServerEvent[] = [];
    const pendingCounts: number[] = [];
    const context = new WebExtensionUIContext(
        "session-a",
        (event) => events.push(event),
        1_000,
        () => ({ messageId: "message-a", toolCallId: "tool-a" }),
        () => pendingCounts.push(context.pendingCount),
    );

    const selected = context.select("Choose", ["a", "b"]);
    const selectEvent = events.at(-1);
    assert.equal(selectEvent?.type, "ui_select_request");
    assert.equal(context.pendingCount, 1);
    assert.equal(context.pendingRequests[0]?.messageId, "message-a");
    assert.equal(context.pendingRequests[0]?.toolCallId, "tool-a");
    if (selectEvent?.type === "ui_select_request") {
        context.resolveSelect(selectEvent.requestId, "b");
    }
    assert.equal(await selected, "b");

    const input = context.input("Value", "placeholder");
    const inputEvent = events.at(-1);
    assert.equal(inputEvent?.type, "ui_input_request");
    if (inputEvent?.type === "ui_input_request") {
        context.resolveInput(inputEvent.requestId, "typed");
    }
    assert.equal(await input, "typed");

    const confirmed = context.confirm("Confirm", "Proceed?");
    const confirmEvent = events.at(-1);
    assert.equal(confirmEvent?.type, "ui_confirm_request");
    if (confirmEvent?.type === "ui_confirm_request") {
        context.resolveSelect(confirmEvent.requestId, "wrong-kind");
        assert.equal(context.pendingCount, 1);
        context.resolveConfirm(confirmEvent.requestId, true);
    }
    assert.equal(await confirmed, true);
    assert.equal(context.pendingCount, 0);
    assert.deepEqual(pendingCounts, [1, 0, 1, 0, 1, 0]);
});

/**
 * Purpose: Verify timeout and cancellation always settle extension promises with
 * type-safe fallback values and remove every pending request.
 * Expect: Timed-out/cancelled confirms resolve false; select/input resolve undefined.
 * Method: Let one request set expire, then cancel a second set explicitly.
 */
Deno.test("WebExtensionUIContext settles timed out and cancelled requests", async () => {
    const timed = new WebExtensionUIContext("session-a", () => {}, 5);
    const timedResults = await Promise.all([
        timed.select("Select", ["a"]),
        timed.input("Input"),
        timed.confirm("Confirm", "Continue?"),
    ]);
    assert.deepEqual(timedResults, [undefined, undefined, false]);
    assert.equal(timed.pendingCount, 0);

    const cancelled = new WebExtensionUIContext("session-a", () => {}, 10_000);
    const select = cancelled.select("Select", ["a"]);
    const input = cancelled.input("Input");
    const confirm = cancelled.confirm("Confirm", "Continue?");
    assert.equal(cancelled.pendingCount, 3);

    cancelled.cancelAll();

    assert.deepEqual(await Promise.all([select, input, confirm]), [
        undefined,
        undefined,
        false,
    ]);
    assert.equal(cancelled.pendingCount, 0);
});

/**
 * Purpose: Verify widget projection owns rendered lines and component disposal
 * while isolating extension renderer failures from the session runtime.
 * Expect: Lines are copied/filtered, replacements dispose old components, and failures notify.
 * Method: Register array/factory/error widgets, request rerenders, replace, and remove them.
 */
Deno.test("WebExtensionUIContext projects and disposes extension widgets", () => {
    const events: ServerEvent[] = [];
    const context = new WebExtensionUIContext(
        "session-a",
        (event) => events.push(event),
        1_000,
    );

    const sourceLines = ["first"];
    context.setWidget("array", sourceLines, { placement: "belowEditor" });
    sourceLines.push("mutated");
    assert.deepEqual(context.extensionWidgets, [{
        key: "array",
        placement: "belowEditor",
        lines: ["first"],
    }]);

    let renderLines: unknown[] = ["rendered", 42];
    let requestRender: (() => void) | undefined;
    let disposeCalls = 0;
    context.setWidget("factory", (tui) => {
        requestRender = (tui as { requestRender: () => void }).requestRender;
        return {
            render: () => renderLines,
            dispose: () => disposeCalls++,
        };
    });
    assert.deepEqual(
        context.extensionWidgets.find((widget) => widget.key === "factory")
            ?.lines,
        ["rendered"],
    );

    renderLines = ["updated"];
    requestRender?.();
    assert.deepEqual(
        context.extensionWidgets.find((widget) => widget.key === "factory")
            ?.lines,
        ["updated"],
    );

    context.setWidget("factory", ["replacement"]);
    assert.equal(disposeCalls, 1);
    context.setWidget("factory", undefined);
    assert.ok(
        !context.extensionWidgets.some((widget) => widget.key === "factory"),
    );

    context.setWidget("broken", () => ({
        render: () => {
            throw new Error("widget failed");
        },
    }));
    assert.ok(events.some((event) =>
        event.type === "ui_notify" &&
        event.level === "error" &&
        event.message === "widget failed"
    ));

    const removal = events.findLast((event) =>
        event.type === "extension_widget_update" && event.key === "factory"
    );
    assert.deepEqual(removal, {
        type: "extension_widget_update",
        sessionId: "session-a",
        key: "factory",
    });
});
