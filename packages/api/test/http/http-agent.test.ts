import assert from "node:assert/strict";
import { BadRequestError } from "../../src/errors.ts";
import { agentHttpError } from "../../src/http/agent.ts";
import { HttpError, jsonError } from "../../src/http/errors.ts";

/**
 * Purpose: Verify agentHttpError treats typed domain/HTTP errors as authoritative
 * so status, code, recoverability, and object identity are never reclassified.
 * Expect: Domain metadata is preserved and an existing HttpError is returned unchanged.
 * Method: Map a BadRequestError and inspect its full payload, then pass a prebuilt
 * conflict HttpError and assert the mapper returns the same instance.
 */
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

/**
 * Purpose: Prevent SDK/runtime message wording from masquerading as a client error,
 * which would hide server failures behind unstable substring classification.
 * Expect: Every untyped failure maps to non-recoverable HTTP 500 agent_error.
 * Method: Table-drive Error instances containing every former trigger phrase and
 * assert each result has the identical message but HTTP 500 agent_error metadata.
 */
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
