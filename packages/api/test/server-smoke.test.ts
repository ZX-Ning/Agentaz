import { hashAdminPassword } from "../src/auth/auth.ts";
import { fileURLToPath } from "node:url";
import {
    DEFAULT_API_BODY_LIMIT_BYTES,
    LOGIN_BODY_LIMIT_BYTES,
    MESSAGE_BODY_LIMIT_BYTES,
} from "../src/http/body-limit.ts";

const ADMIN_PASSWORD = "test-password";
const SESSION_SECRET = "01234567890123456789012345678901";

/**
 * Purpose: Verify the production app assembly enforces the same admin session
 * boundary for normal HTTP and long-lived SSE endpoints, including logout.
 * Expect: Protected routes reject anonymous requests and accept a valid cookie lifecycle.
 * Method: Start createApp().fetch on an ephemeral localhost port, probe anonymous
 * health/SSE, log in, replay the cookie to health, log out, and retry protected access.
 */
Deno.test({
    name: "Deno server smoke test covers auth, health, and SSE protection",
    permissions: {
        env: true,
        read: true,
        net: ["127.0.0.1"],
        sys: ["homedir"],
    },
    fn: runServerSmokeTest,
});

/**
 * Purpose: Verify SPA history fallback serves the application shell only for
 * browser document navigation and never converts missing asset requests into HTML.
 * Expect: Browser document routes return index.html while unknown assets return 404.
 * Method: Point STATIC_FILE_DIR at web-ui, request /login with text/html Accept,
 * then request a missing JavaScript asset with a wildcard Accept header.
 */
Deno.test({
    name: "Static file serving falls back to index.html for SPA routes",
    permissions: {
        env: true,
        read: true,
    },
    fn: runStaticFallbackTest,
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
    permissions: {
        env: true,
        read: true,
    },
    fn: runBodyLimitTest,
});

async function runServerSmokeTest() {
    using _env = withAuthEnv();
    const { createApp } = await import("../src/main.ts");
    const server = Deno.serve(
        {
            hostname: "127.0.0.1",
            port: 0,
            onListen: () => {},
        },
        createApp().fetch,
    );
    const baseUrl = `http://${server.addr.hostname}:${server.addr.port}`;

    try {
        const unauthenticatedHealth = await requestJson(
            baseUrl,
            "GET",
            "/api/health",
        );
        assertStatus(unauthenticatedHealth.response, 401);

        const unauthenticatedSse = await fetch(
            `${baseUrl}/api/agent/events`,
        );
        assertStatus(unauthenticatedSse, 401);
        await unauthenticatedSse.body?.cancel();

        const login = await requestJson(
            baseUrl,
            "POST",
            "/api/auth/login",
            { password: ADMIN_PASSWORD },
        );
        assertStatus(login.response, 200);
        if (login.payload?.user?.id !== "admin") {
            throw new Error("login should return the admin user");
        }

        const cookie = cookieHeader(login.response);
        if (!cookie.includes("better-auth.session_token=")) {
            throw new Error("login should set an encrypted session cookie");
        }

        const health = await requestJson(
            baseUrl,
            "GET",
            "/api/health",
            undefined,
            cookie,
        );
        assertStatus(health.response, 200);
        if (
            health.payload?.ok !== true ||
            health.payload?.service !== "pi-web-agent"
        ) {
            throw new Error("health should return the service payload");
        }

        const logout = await requestJson(
            baseUrl,
            "POST",
            "/api/auth/logout",
            undefined,
            cookie,
        );
        assertStatus(logout.response, 200);

        const clearedCookie = cookieHeader(logout.response);
        const loggedOutHealth = await requestJson(
            baseUrl,
            "GET",
            "/api/health",
            undefined,
            clearedCookie,
        );
        assertStatus(loggedOutHealth.response, 401);
    }
    finally {
        await server.shutdown();
    }
}

async function runStaticFallbackTest() {
    const staticDir = fileURLToPath(new URL("../../web-ui", import.meta.url));
    using _env = withStaticDirEnv(staticDir);

    const { createApp } = await import("../src/main.ts");
    const app = createApp();

    const login = await app.fetch(
        new Request("http://agentaz.test/login", {
            headers: { accept: "text/html" },
        }),
    );
    assertStatus(login, 200);
    if (!await login.text().then((text) => text.includes("Agentaz"))) {
        throw new Error("SPA route should return index.html");
    }

    const asset = await app.fetch(
        new Request("http://agentaz.test/missing.js", {
            headers: { accept: "*/*" },
        }),
    );
    assertStatus(asset, 404);
}

async function runBodyLimitTest() {
    using _env = withAuthEnv();
    const { createApp } = await import("../src/main.ts");
    const app = createApp();

    const oversizedLogin = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "x".repeat(LOGIN_BODY_LIMIT_BYTES) }),
    });
    await assertPayloadTooLarge(oversizedLogin, LOGIN_BODY_LIMIT_BYTES);

    // No Content-Length: exercise the middleware's streamed-body accounting.
    const oversizedStream = byteStream(DEFAULT_API_BODY_LIMIT_BYTES + 1);
    const oversizedApi = await app.fetch(
        new Request("http://agentaz.test/api/agent/permissions/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: oversizedStream,
        }),
    );
    await assertPayloadTooLarge(oversizedApi, DEFAULT_API_BODY_LIMIT_BYTES);

    // Message requests intentionally use the larger image-capable ceiling.
    const acceptedByMessageLimit = await app.fetch(
        new Request(
            "http://agentaz.test/api/agent/sessions/session-a/messages",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: byteStream(DEFAULT_API_BODY_LIMIT_BYTES + 1),
            },
        ),
    );
    assertStatus(acceptedByMessageLimit, 401);

    const oversizedMessage = await app.request(
        "/api/agent/sessions/session-a/messages",
        {
            method: "POST",
            headers: {
                "content-length": String(MESSAGE_BODY_LIMIT_BYTES + 1),
                "content-type": "application/json",
            },
            body: "{}",
        },
    );
    await assertPayloadTooLarge(oversizedMessage, MESSAGE_BODY_LIMIT_BYTES);
}

async function assertPayloadTooLarge(response: Response, maxSize: number) {
    assertStatus(response, 413);
    const payload = await response.json();
    if (
        payload.code !== "payload_too_large" ||
        payload.message !== `Request body exceeds the ${maxSize}-byte limit.` ||
        payload.recoverable !== true
    ) {
        throw new Error("body limit should return the structured API error");
    }
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

function assertStatus(response: Response, expected: number) {
    if (response.status !== expected) {
        throw new Error(
            `expected HTTP ${expected}, got ${response.status}`,
        );
    }
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

function withStaticDirEnv(staticDir: string) {
    const previousStaticDir = Deno.env.get("STATIC_FILE_DIR");
    Deno.env.set("STATIC_FILE_DIR", staticDir);

    return {
        [Symbol.dispose]() {
            restoreEnv("STATIC_FILE_DIR", previousStaticDir);
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
