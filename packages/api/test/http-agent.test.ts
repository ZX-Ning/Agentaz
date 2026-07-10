import assert from "node:assert/strict";
import { BadRequestError } from "../src/errors.ts";
import { agentHttpError } from "../src/http/agent.ts";
import { HttpError, jsonError } from "../src/http/errors.ts";

Deno.test("agentHttpError preserves typed domain and HTTP errors", () => {
    const domain = agentHttpError(new BadRequestError("Field is required."));
    assert.equal(domain.status, 400);
    assert.deepEqual(domain.data, {
        code: "bad_request",
        message: "Field is required.",
        recoverable: true,
    });

    const existing = jsonError(409, "conflict", "Already running.");
    assert.equal(agentHttpError(existing), existing);
});

Deno.test("agentHttpError maps all untyped failures to 500", () => {
    const messages = [
        "A provider credential is required.",
        "No loaded session survived an SDK failure.",
        "Loaded session limit reached while refreshing metadata.",
        "Session is busy because internal cleanup failed.",
        "Unknown model registry failure.",
        "Agent is running but its transport failed.",
    ];

    for (const message of messages) {
        const error = agentHttpError(new Error(message));
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 500);
        assert.deepEqual(error.data, {
            code: "agent_error",
            message,
            recoverable: false,
        });
    }
});
