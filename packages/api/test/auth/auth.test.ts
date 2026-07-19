import assert from "node:assert/strict";
import { Hono } from "@hono/hono";
import { symmetricEncodeJWT } from "better-auth/crypto";
import {
    assertAuthConfig,
    authMiddleware,
    clearAuthSession,
    getAuthSession,
    hashAdminPassword,
    signInWithAdminPassword,
    verifyAdminPassword,
} from "../../src/auth/auth.ts";
import { HttpError } from "../../src/http/errors.ts";

const HASH_ENV = "AGENTAZ_ADMIN_PASSWORD_HASH";
const SECRET_ENV = "AGENTAZ_SESSION_SECRET";
const COOKIE = "better-auth.session_token";
const SALT = "agentaz-admin-session";

Deno.test({
    name: "auth validates password and startup configuration",
    permissions: { env: true },
    async fn() {
        using _env = withAuthEnv(undefined, undefined);
        assert.throws(() => assertAuthConfig(), /must be provided/);

        Deno.env.set(HASH_ENV, hashAdminPassword("correct"));
        Deno.env.set(SECRET_ENV, "short");
        assert.throws(() => assertAuthConfig(), /at least 32 characters/);

        Deno.env.set(SECRET_ENV, "s".repeat(32));
        assertAuthConfig();
        assert.equal(verifyAdminPassword("correct"), true);
        assert.equal(verifyAdminPassword("incorrect"), false);

        Deno.env.delete(SECRET_ENV);
        using warnings = captureConsoleWarnings();
        assertAuthConfig();
        assert.equal(warnings.messages.length, 1);

        const app = createAuthTestApp();
        const login = await app.request("http://localhost/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: "correct" }),
        });
        const cookie = responseCookie(login);
        const session = await app.request("http://localhost/session", {
            headers: { cookie },
        });
        assert.equal((await session.json()).loggedIn, true);
    },
});

Deno.test({
    name: "auth accepts valid tokens and rejects expired or invalid tokens",
    permissions: { env: true },
    async fn() {
        const secret = "v".repeat(32);
        using _env = withAuthEnv(hashAdminPassword("correct"), secret);
        assertAuthConfig();
        const app = createAuthTestApp();
        const login = await app.request("http://localhost/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: "correct" }),
        });
        const validCookie = responseCookie(login);

        assert.equal(await sessionLoggedIn(app, validCookie), true);
        assert.equal(await sessionLoggedIn(app, `${COOKIE}=malformed`), false);

        const now = Date.now();
        const expired = await token(
            secret,
            SALT,
            { sub: "admin", loggedInAt: now - 2_000, expiresAt: now - 1_000 },
        );
        const wrongSecret = await token(
            "w".repeat(32),
            SALT,
            { sub: "admin", loggedInAt: now, expiresAt: now + 60_000 },
        );
        const wrongSalt = await token(
            secret,
            "wrong-salt",
            { sub: "admin", loggedInAt: now, expiresAt: now + 60_000 },
        );
        for (const invalid of [expired, wrongSecret, wrongSalt]) {
            assert.equal(
                await sessionLoggedIn(app, `${COOKIE}=${invalid}`),
                false,
            );
        }
    },
});

Deno.test({
    name: "logout clears the browser cookie without revoking a copied token",
    permissions: { env: true },
    async fn() {
        using _env = withAuthEnv(
            hashAdminPassword("correct"),
            "l".repeat(32),
        );
        assertAuthConfig();
        const app = createAuthTestApp();
        const login = await app.request("http://localhost/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: "correct" }),
        });
        const copiedCookie = responseCookie(login);
        const logout = await app.request("http://localhost/logout", {
            method: "POST",
            headers: { cookie: copiedCookie },
        });

        assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/i);
        assert.equal(await sessionLoggedIn(app, copiedCookie), true);
    },
});

Deno.test({
    name: "auth middleware exposes only exact public method and path pairs",
    permissions: { env: true },
    async fn() {
        using _env = withAuthEnv(
            hashAdminPassword("correct"),
            "p".repeat(32),
        );
        assertAuthConfig();
        const app = new Hono();
        app.onError((error, c) => {
            if (error instanceof HttpError) {
                return c.json(error.data, { status: error.status as 401 });
            }
            throw error;
        });
        app.use("*", authMiddleware);
        app.all("*", (c) => c.json({ ok: true }));

        for (
            const [method, path, status] of [
                ["POST", "/api/auth/login", 200],
                ["GET", "/api/_auth/session", 200],
                ["GET", "/api/auth/login", 401],
                ["POST", "/api/_auth/session", 401],
                ["POST", "/api/auth/login/", 401],
                ["GET", "/api/_auth/session/", 401],
                ["POST", "/api/nested/api/auth/login", 401],
                ["GET", "/api/health", 401],
            ] as const
        ) {
            const response = await app.request(`http://localhost${path}`, {
                method,
            });
            assert.equal(response.status, status, `${method} ${path}`);
        }
    },
});

function createAuthTestApp() {
    const app = new Hono();
    app.post("/login", async (c) => {
        const body = await c.req.json<{ password: string }>();
        const session = await signInWithAdminPassword(c, body.password);
        return c.json(session);
    });
    app.get("/session", async (c) => {
        const session = await getAuthSession(c);
        return c.json({ loggedIn: Boolean(session) });
    });
    app.post("/logout", (c) => {
        clearAuthSession(c);
        return c.json({ ok: true });
    });
    return app;
}

async function sessionLoggedIn(app: Hono, cookie: string) {
    const response = await app.request("http://localhost/session", {
        headers: { cookie },
    });
    return Boolean((await response.json()).loggedIn);
}

function responseCookie(response: Response) {
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    return cookie;
}

function token(
    secret: string,
    salt: string,
    payload: { sub: "admin"; loggedInAt: number; expiresAt: number },
) {
    return symmetricEncodeJWT(payload, secret, salt, 60 * 60);
}

function withAuthEnv(hash: string | undefined, secret: string | undefined) {
    const previousHash = Deno.env.get(HASH_ENV);
    const previousSecret = Deno.env.get(SECRET_ENV);
    setOrDeleteEnv(HASH_ENV, hash);
    setOrDeleteEnv(SECRET_ENV, secret);
    return {
        [Symbol.dispose]() {
            setOrDeleteEnv(HASH_ENV, previousHash);
            setOrDeleteEnv(SECRET_ENV, previousSecret);
        },
    };
}

function setOrDeleteEnv(name: string, value: string | undefined) {
    if (value === undefined) {
        Deno.env.delete(name);
    }
    else {
        Deno.env.set(name, value);
    }
}

function captureConsoleWarnings() {
    const original = console.warn;
    const messages: unknown[][] = [];
    console.warn = (...args: unknown[]) => messages.push(args);
    return {
        messages,
        [Symbol.dispose]() {
            console.warn = original;
        },
    };
}
