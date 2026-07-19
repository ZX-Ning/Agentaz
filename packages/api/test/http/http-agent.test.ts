import assert from "node:assert/strict";
import type { Context } from "@hono/hono";
import { Hono } from "@hono/hono";
import { BadRequestError } from "../../src/errors.ts";
import {
    agentHttpError,
    agentHttpErrorResponse,
    requireRouteParam,
} from "../../src/http/agent.ts";
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
 * assert each result has the same generic HTTP 500 agent_error metadata.
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
            message: "Unexpected server error.",
            recoverable: false,
        });
    }
});

/**
 * Purpose: Prevent route parameters from being decoded a second time after Hono routing.
 * Expect: UUIDs, encoded percent text, and malformed escapes are returned unchanged.
 * Method: Feed representative Hono-decoded values through the required-param helper.
 */
Deno.test("requireRouteParam preserves Hono's single-decoded value", async () => {
    for (
        const value of [
            "550e8400-e29b-41d4-a716-446655440000",
            "session%2Fchild",
            "literal%value",
            "%ZZ",
        ]
    ) {
        const context = {
            req: { param: () => value },
        } as unknown as Context;
        assert.equal(requireRouteParam(context, "sessionId"), value);
    }

    const app = new Hono();
    app.get(
        "/sessions/:sessionId",
        (c) => c.text(requireRouteParam(c, "sessionId")),
    );
    const doubleEncoded = await app.request(
        "http://localhost/sessions/session%252Fchild",
    );
    assert.equal(await doubleEncoded.text(), "session%2Fchild");
    const uuid = await app.request(
        "http://localhost/sessions/550e8400-e29b-41d4-a716-446655440000",
    );
    assert.equal(
        await uuid.text(),
        "550e8400-e29b-41d4-a716-446655440000",
    );
});

/**
 * Purpose: Redact unexpected failures at the HTTP boundary while retaining local diagnostics.
 * Expect: The client gets one generic 500 and the original error is logged exactly once with route context.
 * Method: Throw a secret-bearing error through a Hono app using the production error handler.
 */
Deno.test("HTTP error boundary logs and redacts unexpected failures", async () => {
    using errors = captureConsoleErrors();
    const app = new Hono();
    app.onError(agentHttpErrorResponse);
    app.get("/boom", () => {
        throw new Error("secret filesystem detail");
    });

    const response = await app.request("http://localhost/boom");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
        code: "agent_error",
        message: "Unexpected server error.",
        recoverable: false,
    });
    assert.equal(errors.messages.length, 1);
    assert.match(String(errors.messages[0]?.[0]), /unexpected request error/);
    assert.deepEqual(errors.messages[0]?.[1], {
        method: "GET",
        path: "/boom",
    });
    assert.equal(errors.messages[0]?.[2] instanceof Error, true);
});

function captureConsoleErrors() {
    const original = console.error;
    const messages: unknown[][] = [];
    console.error = (...args: unknown[]) => messages.push(args);
    return {
        messages,
        [Symbol.dispose]() {
            console.error = original;
        },
    };
}
