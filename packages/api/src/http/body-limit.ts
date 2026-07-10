import type { MiddlewareHandler } from "@hono/hono";
import { bodyLimit } from "@hono/hono/body-limit";

export const LOGIN_BODY_LIMIT_BYTES = 16 * 1024;
export const DEFAULT_API_BODY_LIMIT_BYTES = 1024 * 1024;
export const MESSAGE_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

const MESSAGE_PATH = /^\/api\/agent\/sessions\/[^/]+\/messages$/;

/** Returns the request-body ceiling for one API path. */
export function apiBodyLimitBytes(path: string) {
    if (path === "/api/auth/login") {
        return LOGIN_BODY_LIMIT_BYTES;
    }
    if (MESSAGE_PATH.test(path)) {
        return MESSAGE_BODY_LIMIT_BYTES;
    }
    return DEFAULT_API_BODY_LIMIT_BYTES;
}

const limiters = new Map<number, MiddlewareHandler>();

/** Limits both declared-length and streamed API bodies before parsing or auth. */
export const apiBodyLimit: MiddlewareHandler = (c, next) => {
    const maxSize = apiBodyLimitBytes(c.req.path);
    let limiter = limiters.get(maxSize);
    if (!limiter) {
        limiter = bodyLimit({
            maxSize,
            onError: (c) =>
                c.json(
                    {
                        code: "payload_too_large",
                        message:
                            `Request body exceeds the ${maxSize}-byte limit.`,
                        recoverable: true,
                    },
                    413,
                ),
        });
        limiters.set(maxSize, limiter);
    }
    return limiter(c, next);
};
