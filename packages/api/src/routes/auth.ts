import { Hono } from "@hono/hono";
import type { AuthLoginRequest, AuthLoginResponse } from "@agentaz/protocol";
import { readJsonBody } from "../http/request.ts";
import {
    clearAuthSession,
    getAuthSession,
    signInWithAdminPassword,
} from "../auth/auth.ts";
import { jsonError } from "../http/errors.ts";

export const authRoutes = new Hono();

authRoutes.post("/auth/login", async (c) => {
    const body = await readJsonBody<AuthLoginRequest>(c);
    if (!body.password) {
        throw jsonError(400, "bad_request", "Password is required.");
    }
    const session = await signInWithAdminPassword(c, body.password);
    return c.json<AuthLoginResponse>({
        ok: true,
        user: session.user,
        loggedInAt: session.loggedInAt,
    });
});

authRoutes.post("/auth/logout", async (c) => {
    await clearAuthSession(c);
    return c.json({ ok: true });
});

authRoutes.get("/_auth/session", async (c) => {
    const session = await getAuthSession(c);
    return c.json({
        loggedIn: Boolean(session),
        user: session?.user,
        loggedInAt: session?.loggedInAt,
    });
});
