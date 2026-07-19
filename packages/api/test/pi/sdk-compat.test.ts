import assert from "node:assert/strict";
import { compactUnavailableMessage } from "../../src/pi/sdk-compat.ts";

Deno.test("Pi compact adapter recognizes only pinned 0.80.6 messages", () => {
    for (
        const message of [
            "Nothing to compact (session too small)",
            "Already compacted",
        ]
    ) {
        assert.equal(compactUnavailableMessage(new Error(message)), message);
    }

    for (
        const error of [
            new Error("Nothing to compact"),
            new Error("Already compacted."),
            new Error("storage failed"),
            "Already compacted",
            undefined,
        ]
    ) {
        assert.equal(compactUnavailableMessage(error), undefined);
    }
});
