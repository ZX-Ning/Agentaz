import { Hono } from "@hono/hono";
import type { AuthLoginRequest, AuthLoginResponse } from "@agentaz/protocol";
import { readJsonBody } from "../http/agent.ts";
import {
    clearAuthSession,
    getAuthSession,
    setAuthSession,
    unauthorizedError,
    verifyAdminPassword,
} from "../auth/auth.ts";
import { jsonError } from "../http/errors.ts";

export const authRoutes = new Hono();

authRoutes.post("/auth/login", async c => {
    const body = await readJsonBody<AuthLoginRequest>(c);
    if (!body.password) {
        throw jsonError(400, "bad_request", "Password is required.");
    }
    if (!verifyAdminPassword(body.password)) {
        throw unauthorizedError("Invalid password.");
    }

    const session = await setAuthSession(c);
    return c.json<AuthLoginResponse>({
        ok: true,
        user: session.user,
        loggedInAt: session.loggedInAt,
    });
});

authRoutes.post("/auth/logout", c => {
    clearAuthSession(c);
    return c.json({ ok: true });
});

authRoutes.get("/_auth/session", async c => {
    const session = await getAuthSession(c);
    return c.json({
        loggedIn: Boolean(session),
        user: session?.user,
        loggedInAt: session?.loggedInAt,
    });
});
