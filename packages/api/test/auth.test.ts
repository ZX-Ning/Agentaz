import { Hono } from "@hono/hono";
import {
    authMiddleware,
    clearAuthSession,
    getAuthSession,
    hashAdminPassword,
    signInWithAdminPassword,
} from "../src/auth/auth.ts";
import { HttpError, jsonError } from "../src/http/errors.ts";

const ADMIN_PASSWORD = "test-password";
const SESSION_SECRET = "01234567890123456789012345678901";

Deno.test({
    name: "Better Auth encrypted cookie session protects API routes",
    permissions: {
        env: ["AGENTAZ_ADMIN_PASSWORD_HASH", "AGENTAZ_SESSION_SECRET"],
    },
    async fn() {
        using _env = withAuthEnv();
        const app = createTestApp();

        const unauthenticated = await app.request("/api/health");
        if (unauthenticated.status !== 401) {
            const body = await unauthenticated.text();
            throw new Error(
                `health should reject unauthenticated requests, got ${unauthenticated.status}: ${body}`,
            );
        }

        const login = await app.request("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ password: ADMIN_PASSWORD }),
            headers: { "content-type": "application/json" },
        });
        if (login.status !== 200) {
            throw new Error(`login should succeed, got ${login.status}`);
        }

        const cookie = cookieHeader(login);
        if (!cookie.includes("better-auth.session_token=")) {
            throw new Error("login should set the Better Auth session cookie");
        }

        const session = await app.request("/api/_auth/session", {
            headers: { cookie },
        });
        const sessionBody = await session.json();
        if (!sessionBody.loggedIn || sessionBody.user?.id !== "admin") {
            throw new Error("session endpoint should return the admin session");
        }

        const authenticated = await app.request("/api/health", {
            headers: { cookie },
        });
        if (authenticated.status !== 200) {
            throw new Error("health should allow authenticated requests");
        }
    },
});

Deno.test({
    name:
        "Better Auth encrypted cookie session rejects bad password and clears on logout",
    permissions: {
        env: ["AGENTAZ_ADMIN_PASSWORD_HASH", "AGENTAZ_SESSION_SECRET"],
    },
    async fn() {
        using _env = withAuthEnv();
        const app = createTestApp();

        const rejected = await app.request("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ password: "wrong" }),
            headers: { "content-type": "application/json" },
        });
        if (rejected.status !== 401) {
            throw new Error("invalid password should be rejected");
        }

        const login = await app.request("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ password: ADMIN_PASSWORD }),
            headers: { "content-type": "application/json" },
        });
        const cookie = cookieHeader(login);

        const logout = await app.request("/api/auth/logout", {
            method: "POST",
            headers: { cookie },
        });
        if (logout.status !== 200) {
            throw new Error("logout should succeed");
        }

        const clearedCookie = cookieHeader(logout);
        const session = await app.request("/api/_auth/session", {
            headers: { cookie: clearedCookie },
        });
        const sessionBody = await session.json();
        if (sessionBody.loggedIn) {
            throw new Error("session endpoint should report logged out");
        }
    },
});

function createTestApp() {
    const app = new Hono();
    app.onError((error, c) => {
        const httpError = error instanceof HttpError
            ? error
            : jsonError(500, "test_error", String(error));
        return c.json(httpError.data, { status: httpError.status as 400 });
    });
    app.use("/api/*", authMiddleware);
    app.post("/api/auth/login", async (c) => {
        const body = await c.req.json<{ password?: string }>();
        if (!body.password) {
            throw jsonError(400, "bad_request", "Password is required.");
        }
        const session = await signInWithAdminPassword(c, body.password);
        return c.json({
            ok: true,
            user: session.user,
            loggedInAt: session.loggedInAt,
        });
    });
    app.post("/api/auth/logout", async (c) => {
        await clearAuthSession(c);
        return c.json({ ok: true });
    });
    app.get("/api/_auth/session", async (c) => {
        const session = await getAuthSession(c);
        return c.json({
            loggedIn: Boolean(session),
            user: session?.user,
            loggedInAt: session?.loggedInAt,
        });
    });
    app.get("/api/health", (c) => c.json({ ok: true }));
    return app;
}

function cookieHeader(response: Response) {
    const getSetCookie = (response.headers as Headers & {
        getSetCookie?: () => string[];
    }).getSetCookie;
    return (getSetCookie?.call(response.headers) ?? [])
        .map((cookie) => cookie.split(";", 1)[0])
        .join("; ");
}

function withAuthEnv() {
    const previousHash = Deno.env.get("AGENTAZ_ADMIN_PASSWORD_HASH");
    const previousSecret = Deno.env.get("AGENTAZ_SESSION_SECRET");

    Deno.env.set(
        "AGENTAZ_ADMIN_PASSWORD_HASH",
        hashAdminPassword(ADMIN_PASSWORD),
    );
    Deno.env.set("AGENTAZ_SESSION_SECRET", SESSION_SECRET);

    return {
        [Symbol.dispose]() {
            restoreEnv("AGENTAZ_ADMIN_PASSWORD_HASH", previousHash);
            restoreEnv("AGENTAZ_SESSION_SECRET", previousSecret);
        },
    };
}

function restoreEnv(name: string, value: string | undefined) {
    if (value === undefined) {
        Deno.env.delete(name);
        return;
    }
    Deno.env.set(name, value);
}
