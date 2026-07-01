import type { Context } from "@hono/hono";
import { jsonError } from "./errors.ts";

/** Reads a JSON body, defaulting empty bodies to `{}` and rejecting malformed JSON. */
export async function readJsonBody<T extends object>(
    c: Context,
): Promise<Partial<T>> {
    const contentLength = c.req.header("content-length");
    if (contentLength === "0") {
        return {};
    }

    try {
        return (await c.req.json()) ?? {};
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            throw jsonError(
                400,
                "bad_request",
                "Malformed JSON request body.",
            );
        }
        // Hono throws when there is no body; routes with optional JSON treat it as empty.
        if (
            error instanceof Error &&
            error.message.includes("Unexpected end")
        ) {
            return {};
        }
        throw error;
    }
}
