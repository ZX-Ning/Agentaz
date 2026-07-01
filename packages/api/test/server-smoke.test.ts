import { hashAdminPassword } from "../src/auth/auth.ts";
import { fileURLToPath } from "node:url";

const ADMIN_PASSWORD = "test-password";
const SESSION_SECRET = "01234567890123456789012345678901";

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

Deno.test({
    name: "Static file serving falls back to index.html for SPA routes",
    permissions: {
        env: true,
        read: true,
    },
    fn: runStaticFallbackTest,
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
