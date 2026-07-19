/// <reference path="../src/env.d.ts" />
/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { THINKING_LEVELS } from "@agentaz/protocol";
import {
    closestThinkingLevel,
    isThinkingLevel,
    thinkingOptions,
} from "../src/utils/app.util.ts";

Deno.test("frontend thinking helpers cover the protocol level set", () => {
    assert.deepEqual(
        thinkingOptions.map((option) => option.value),
        [...THINKING_LEVELS],
    );
    for (const level of THINKING_LEVELS) {
        assert.equal(isThinkingLevel(level), true);
        assert.equal(closestThinkingLevel(level, [...THINKING_LEVELS]), level);
    }
    assert.equal(isThinkingLevel("invalid"), false);
});

Deno.test("frontend thinking fallback follows the ordered level set", () => {
    assert.equal(closestThinkingLevel("max", ["off", "xhigh"]), "xhigh");
    assert.equal(closestThinkingLevel("xhigh", ["off", "max"]), "max");
    assert.equal(closestThinkingLevel("low", ["off", "medium"]), "medium");
});
