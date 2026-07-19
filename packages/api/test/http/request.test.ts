import assert from "node:assert/strict";
import { Hono } from "@hono/hono";
import { HttpError } from "../../src/http/errors.ts";
import { readJsonBody } from "../../src/http/request.ts";

/**
 * Purpose: Pin optional JSON body semantics at every empty/malformed boundary.
 * Expect: Declared-empty, bodyless, and whitespace bodies become {}; truncated
 * and otherwise malformed JSON remain structured 400 responses.
 * Method: Send each raw request shape through a Hono route using readJsonBody.
 */
Deno.test("readJsonBody distinguishes empty bodies from malformed JSON", async () => {
    const app = requestApp();
    const cases = [
        {
            name: "content-length zero",
            headers: { "content-length": "0" },
            expectedStatus: 200,
            expected: {},
        },
        {
            name: "bodyless",
            headers: {},
            expectedStatus: 200,
            expected: {},
        },
        {
            name: "empty JSON parse / Unexpected end",
            headers: { "content-type": "application/json" },
            body: "   ",
            expectedStatus: 200,
            expected: {},
        },
        {
            name: "truncated JSON",
            headers: { "content-type": "application/json" },
            body: '{"value":',
            expectedStatus: 400,
            expected: malformedPayload(),
        },
        {
            name: "malformed JSON",
            headers: { "content-type": "application/json" },
            body: "{invalid",
            expectedStatus: 400,
            expected: malformedPayload(),
        },
    ] as const;

    for (const testCase of cases) {
        const response = await app.request("http://localhost/body", {
            method: "POST",
            headers: testCase.headers,
            body: "body" in testCase ? testCase.body : undefined,
        });
        assert.equal(response.status, testCase.expectedStatus, testCase.name);
        assert.deepEqual(
            await response.json(),
            testCase.expected,
            testCase.name,
        );
    }
});

function requestApp() {
    const app = new Hono();
    app.onError((error, c) => {
        if (error instanceof HttpError) {
            return c.json(error.data, { status: error.status as 400 });
        }
        throw error;
    });
    app.post("/body", async (c) => c.json(await readJsonBody(c)));
    return app;
}

function malformedPayload() {
    return {
        code: "bad_request",
        message: "Malformed JSON request body.",
        recoverable: true,
    };
}
