import { hashAdminPassword } from "../src/auth/auth.ts";
import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
    DEFAULT_API_BODY_LIMIT_BYTES,
    LOGIN_BODY_LIMIT_BYTES,
    MESSAGE_BODY_LIMIT_BYTES,
} from "../src/http/body-limit.ts";

const ADMIN_PASSWORD = "test-password";
const SESSION_SECRET = "01234567890123456789012345678901";
const TEST_PERMISSIONS = {
    env: true,
    read: true,
    write: true,
    net: ["127.0.0.1"],
    sys: ["homedir"],
};

let baseUrl = "";
let shutdownServer: (() => Promise<void>) | undefined;
let authEnv: ReturnType<typeof withAuthEnv> | undefined;
let staticDirEnv: Awaited<ReturnType<typeof withStaticDirEnv>> | undefined;

/** Begins the hook-managed server lifetime shared by every test in this file. */
Deno.test.beforeAll(async () => {
    authEnv = withAuthEnv();

    try {
        staticDirEnv = await withStaticDirEnv();

        const { app } = await import("../src/main.ts");
        const server = Deno.serve(
            {
                hostname: "127.0.0.1",
                port: 0,
                onListen: () => {},
            },
            app.fetch,
        );
        baseUrl = `http://${server.addr.hostname}:${server.addr.port}`;
        shutdownServer = () => server.shutdown();
    }
    catch (error) {
        await disposeTestEnv();
        throw error;
    }
});

/** Ends the hook-managed server lifetime, restoring env even when shutdown fails. */
Deno.test.afterAll(async () => {
    try {
        await shutdownServer?.();
    }
    finally {
        await disposeTestEnv();
    }
});

/**
 * Purpose: Verify anonymous callers cannot cross the production API boundary.
 * Expect: Protected HTTP and SSE routes return 401; public session reports logged out.
 * Method: Request health, agent events, and session through the shared server without a cookie.
 */
Deno.test({
    name:
        "Production server protects HTTP and SSE routes from anonymous access",
    permissions: TEST_PERMISSIONS,
    async fn() {
        const unauthenticatedHealth = await requestJson(
            baseUrl,
            "GET",
            "/api/health",
        );
        assertEquals(unauthenticatedHealth.response.status, 401);

        const unauthenticatedSse = await fetch(
            `${baseUrl}/api/agent/events`,
        );
        assertEquals(unauthenticatedSse.status, 401);
        await unauthenticatedSse.body?.cancel();

        const anonymousSession = await requestJson(
            baseUrl,
            "GET",
            "/api/_auth/session",
        );
        assertEquals(anonymousSession.response.status, 200);
        assertEquals(anonymousSession.payload?.loggedIn, false);
    },
});

Deno.test({
    name: "Production server rejects an invalid admin password",
    permissions: TEST_PERMISSIONS,
    async fn() {
        const rejectedLogin = await requestJson(
            baseUrl,
            "POST",
            "/api/auth/login",
            { password: "wrong" },
        );
        assertEquals(rejectedLogin.response.status, 401);
    },
});

/**
 * Purpose: Verify the production cookie represents the complete admin session lifecycle.
 * Expect: Login sets an admin session accepted by protected routes; logout invalidates it.
 * Method: Replay the login cookie through session and health, then replay its cleared value.
 */
Deno.test({
    name: "Production server supports the admin session lifecycle",
    permissions: TEST_PERMISSIONS,
    async fn() {
        const login = await requestJson(
            baseUrl,
            "POST",
            "/api/auth/login",
            { password: ADMIN_PASSWORD },
        );
        assertEquals(login.response.status, 200);
        assertEquals(login.payload?.user?.id, "admin");

        const cookie = cookieHeader(login.response);
        assertMatch(cookie, /better-auth\.session_token=/);

        const authenticatedSession = await requestJson(
            baseUrl,
            "GET",
            "/api/_auth/session",
            undefined,
            cookie,
        );
        assertEquals(authenticatedSession.response.status, 200);
        assertEquals(authenticatedSession.payload?.loggedIn, true);
        assertEquals(authenticatedSession.payload?.user?.id, "admin");

        const health = await requestJson(
            baseUrl,
            "GET",
            "/api/health",
            undefined,
            cookie,
        );
        assertEquals(health.response.status, 200);
        assertEquals(health.payload?.ok, true);
        assertEquals(health.payload?.service, "pi-web-agent");

        const logout = await requestJson(
            baseUrl,
            "POST",
            "/api/auth/logout",
            undefined,
            cookie,
        );
        assertEquals(logout.response.status, 200);

        const clearedCookie = cookieHeader(logout.response);
        const loggedOutHealth = await requestJson(
            baseUrl,
            "GET",
            "/api/health",
            undefined,
            clearedCookie,
        );
        assertEquals(loggedOutHealth.response.status, 401);

        const loggedOutSession = await requestJson(
            baseUrl,
            "GET",
            "/api/_auth/session",
            undefined,
            clearedCookie,
        );
        assertEquals(loggedOutSession.response.status, 200);
        assertEquals(loggedOutSession.payload?.loggedIn, false);
    },
});

/**
 * Purpose: Verify SPA history fallback serves the application shell only for
 * browser document navigation and never converts missing asset requests into HTML.
 * Expect: Browser document routes return index.html while unknown assets return 404.
 * Method: Serve a temporary index.html, request /login with text/html Accept,
 * then request a missing JavaScript asset with a wildcard Accept header.
 */
Deno.test({
    name: "Static file serving falls back to index.html for SPA routes",
    permissions: TEST_PERMISSIONS,
    async fn() {
        const login = await fetch(`${baseUrl}/login`, {
            headers: { accept: "text/html" },
        });
        assertEquals(login.status, 200);
        assertStringIncludes(await login.text(), "Agentaz test shell");

        const asset = await fetch(`${baseUrl}/missing.js`, {
            headers: { accept: "*/*" },
        });
        assertEquals(asset.status, 404);
    },
});

/**
 * Purpose: Verify each request class enforces its configured memory ceiling before
 * authentication/JSON parsing and that streamed bodies cannot bypass Content-Length checks.
 * Expect: Oversized login, normal, and message bodies return structured 413 responses.
 * Method: Oversize login and normal API bodies using declared and chunked streams,
 * prove message bodies exceed the normal tier, then exceed the dedicated message tier.
 */
Deno.test({
    name:
        "API request body limits reject declared and streamed oversized bodies",
    permissions: TEST_PERMISSIONS,
    async fn() {
        const oversizedLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                password: "x".repeat(LOGIN_BODY_LIMIT_BYTES),
            }),
        });
        await assertPayloadTooLarge(oversizedLogin, LOGIN_BODY_LIMIT_BYTES);

        // No Content-Length: exercise the middleware's streamed-body accounting.
        const oversizedStream = byteStream(DEFAULT_API_BODY_LIMIT_BYTES + 1);
        const oversizedApi = await fetch(
            `${baseUrl}/api/agent/permissions/config`,
            {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: oversizedStream,
            },
        );
        await assertPayloadTooLarge(oversizedApi, DEFAULT_API_BODY_LIMIT_BYTES);

        // Message requests intentionally use the larger image-capable ceiling.
        const messageUrl = `${baseUrl}/api/agent/sessions/session-a/messages`;
        const acceptedByMessageLimit = await fetch(
            messageUrl,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: byteStream(DEFAULT_API_BODY_LIMIT_BYTES + 1),
            },
        );
        assertEquals(acceptedByMessageLimit.status, 401);

        const oversizedMessage = await fetch(messageUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: new Uint8Array(MESSAGE_BODY_LIMIT_BYTES + 1),
        });
        await assertPayloadTooLarge(oversizedMessage, MESSAGE_BODY_LIMIT_BYTES);
    },
});

async function assertPayloadTooLarge(response: Response, maxSize: number) {
    assertEquals(response.status, 413);
    const payload = await response.json();
    assertEquals(payload, {
        code: "payload_too_large",
        message: `Request body exceeds the ${maxSize}-byte limit.`,
        recoverable: true,
    });
}

function byteStream(size: number) {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array(size));
            controller.close();
        },
    });
}

async function requestJson(
    baseUrl: string,
    method: string,
    path: string,
    body?: unknown,
    cookie?: string,
) {
    const headers = new Headers();
    if (body !== undefined) {
        headers.set("content-type", "application/json");
    }
    if (cookie) {
        headers.set("cookie", cookie);
    }

    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
        response,
        payload: text ? JSON.parse(text) : undefined,
    };
}

function cookieHeader(response: Response) {
    const getSetCookie = (response.headers as Headers & {
        getSetCookie?: () => string[];
    }).getSetCookie;
    const setCookies = getSetCookie?.call(response.headers) ??
        [response.headers.get("set-cookie") ?? ""];
    return setCookies
        .filter(Boolean)
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

async function withStaticDirEnv() {
    const previousStaticDir = Deno.env.get("STATIC_FILE_DIR");
    const staticDir = await Deno.makeTempDir({ prefix: "agentaz-static-" });

    try {
        await Deno.writeTextFile(
            `${staticDir}/index.html`,
            "<!doctype html><title>Agentaz test shell</title>",
        );
        Deno.env.set("STATIC_FILE_DIR", staticDir);
    }
    catch (error) {
        await Deno.remove(staticDir, { recursive: true });
        throw error;
    }

    return {
        async [Symbol.asyncDispose]() {
            restoreEnv("STATIC_FILE_DIR", previousStaticDir);
            await Deno.remove(staticDir, { recursive: true });
        },
    };
}

async function disposeTestEnv() {
    const currentStaticDirEnv = staticDirEnv;
    const currentAuthEnv = authEnv;
    staticDirEnv = undefined;
    authEnv = undefined;

    try {
        await currentStaticDirEnv?.[Symbol.asyncDispose]();
    }
    finally {
        currentAuthEnv?.[Symbol.dispose]();
    }
}

function restoreEnv(name: string, value: string | undefined) {
    if (value === undefined) {
        Deno.env.delete(name);
        return;
    }
    Deno.env.set(name, value);
}
