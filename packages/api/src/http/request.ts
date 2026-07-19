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

    const text = await c.req.text();
    // Fetch/Hono surface a bodyless JSON parse as "Unexpected end". Inspecting
    // the raw body first distinguishes truly empty input from truncated JSON.
    if (!text.trim()) {
        return {};
    }

    try {
        return JSON.parse(text) ?? {};
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            throw jsonError(
                400,
                "bad_request",
                "Malformed JSON request body.",
            );
        }
        throw error;
    }
}
