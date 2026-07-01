import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie } from "@hono/hono/cookie";
import type { Context, Next } from "@hono/hono";
import { symmetricDecodeJWT, symmetricEncodeJWT } from "better-auth/crypto";
import { jsonError } from "../http/errors.ts";

const ADMIN_PASSWORD_HASH_ENV = "AGENTAZ_ADMIN_PASSWORD_HASH";
const SESSION_SECRET_ENV = "AGENTAZ_SESSION_SECRET";
const MIN_SESSION_SECRET_LENGTH = 32;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24;
const SESSION_COOKIE = "better-auth.session_token";
const SESSION_TOKEN_SALT = "agentaz-admin-session";

type SessionTokenPayload = {
    sub: "admin";
    loggedInAt: number;
    expiresAt: number;
};

export type AdminAuthSession = {
    user: { id: "admin" };
    expires: string;
    loggedInAt: number;
};

let processSessionSecret = "";

export function requireAdminPasswordHash() {
    const hash = Deno.env.get(ADMIN_PASSWORD_HASH_ENV)?.trim();
    if (!hash) {
        throw new Error(`${ADMIN_PASSWORD_HASH_ENV} must be provided.`);
    }
    return hash;
}

/** Validates auth env and creates a process-local Better Auth secret when omitted. */
export function assertAuthConfig() {
    requireAdminPasswordHash();

    const configured = Deno.env.get(SESSION_SECRET_ENV) || "";
    processSessionSecret = configured || randomBytes(32).toString("base64url");

    if (!configured) {
        console.warn(
            `${SESSION_SECRET_ENV} is not set; generated a process-local Better Auth secret. Existing browser sessions will be invalid after restart.`,
        );
    }
    if (processSessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
        throw new Error(
            `${SESSION_SECRET_ENV} must be at least ${MIN_SESSION_SECRET_LENGTH} characters.`,
        );
    }
}

export function hashAdminPassword(password: string) {
    return createHash("sha3-256").update(password, "utf8").digest("base64");
}

export function verifyAdminPassword(password: string) {
    const expected = Buffer.from(requireAdminPasswordHash(), "base64");
    const actual = Buffer.from(hashAdminPassword(password), "base64");
    return (
        expected.length === actual.length && timingSafeEqual(expected, actual)
    );
}

export function unauthorizedError(message = "Authentication required.") {
    return jsonError(401, "unauthorized", message);
}

function requireSessionSecret() {
    if (!processSessionSecret) {
        assertAuthConfig();
    }
    return processSessionSecret;
}

export async function signInWithAdminPassword(
    c: Context,
    password: string,
): Promise<AdminAuthSession> {
    if (!verifyAdminPassword(password)) {
        throw unauthorizedError("Invalid password.");
    }

    const loggedInAt = Date.now();
    const expiresAt = loggedInAt + SESSION_MAX_AGE_SECONDS * 1000;
    const session = adminSession({ sub: "admin", loggedInAt, expiresAt });
    const token = await symmetricEncodeJWT<SessionTokenPayload>(
        { sub: "admin", loggedInAt, expiresAt },
        requireSessionSecret(),
        SESSION_TOKEN_SALT,
        SESSION_MAX_AGE_SECONDS,
    );

    setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "Lax",
        secure: new URL(c.req.url).protocol === "https:",
        path: "/",
        maxAge: SESSION_MAX_AGE_SECONDS,
    });

    return session;
}

export function clearAuthSession(c: Context) {
    setCookie(c, SESSION_COOKIE, "", {
        httpOnly: true,
        sameSite: "Lax",
        secure: new URL(c.req.url).protocol === "https:",
        path: "/",
        maxAge: 0,
    });
}

export async function getAuthSession(
    c: Context,
): Promise<AdminAuthSession | undefined> {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) {
        return undefined;
    }

    const payload = await symmetricDecodeJWT<SessionTokenPayload>(
        token,
        requireSessionSecret(),
        SESSION_TOKEN_SALT,
    );
    if (
        !payload || payload.sub !== "admin" || payload.expiresAt <= Date.now()
    ) {
        return undefined;
    }

    return adminSession(payload);
}

export async function requireAgentazAuth(c: Context) {
    const session = await getAuthSession(c);
    if (!session) {
        throw unauthorizedError();
    }
    return session;
}

function adminSession(payload: SessionTokenPayload): AdminAuthSession {
    return {
        user: { id: "admin" },
        expires: new Date(payload.expiresAt).toISOString(),
        loggedInAt: payload.loggedInAt,
    };
}

function isPublicApiPath(path: string) {
    return (
        path.endsWith("/api/auth/login") || path.endsWith("/api/_auth/session")
    );
}

/** Hono middleware protecting every `/api/**` endpoint except public auth. */
export async function authMiddleware(c: Context, next: Next) {
    const path = new URL(c.req.url).pathname;
    if (!path.includes("/api/") || isPublicApiPath(path)) {
        return await next();
    }

    await requireAgentazAuth(c);
    return await next();
}
