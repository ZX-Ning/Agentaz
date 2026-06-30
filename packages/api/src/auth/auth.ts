import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie } from "@hono/hono/cookie";
import type { Context, Next } from "@hono/hono";
import { jsonError } from "../http/errors.ts";

const ADMIN_PASSWORD_HASH_ENV = "AGENTAZ_ADMIN_PASSWORD_HASH";
const SESSION_SECRET_ENV = "AGENTAZ_SESSION_SECRET";
const LEGACY_SESSION_SECRET_ENV = "NUXT_SESSION_PASSWORD";
const MIN_SESSION_SECRET_LENGTH = 32;
const SESSION_COOKIE = "agentaz_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24;

type AuthSession = {
    user: { id: "admin" };
    loggedInAt: number;
    expiresAt: number;
};

let processSessionSecret = "";

export function requireAdminPasswordHash() {
    const hash = Deno.env.get(ADMIN_PASSWORD_HASH_ENV)?.trim();
    if (!hash) throw new Error(`${ADMIN_PASSWORD_HASH_ENV} must be provided.`);
    return hash;
}

/** Validates auth env and creates a process-local cookie secret when omitted. */
export function assertAuthConfig() {
    requireAdminPasswordHash();

    const configured =
        Deno.env.get(SESSION_SECRET_ENV) ||
        Deno.env.get(LEGACY_SESSION_SECRET_ENV) ||
        "";
    processSessionSecret = configured || randomBytes(32).toString("base64url");

    if (!configured) {
        console.warn(
            `${SESSION_SECRET_ENV} is not set; generated a process-local session cookie secret. Existing browser sessions will be invalid after restart.`,
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
    if (!processSessionSecret) assertAuthConfig();
    return processSessionSecret;
}

async function hmac(payload: string) {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(requireSessionSecret()),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(payload),
    );
    return encodeBase64Url(new Uint8Array(signature));
}

function encodeBase64Url(bytes: Uint8Array) {
    return btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
}

function encodeTextBase64Url(text: string) {
    return encodeBase64Url(new TextEncoder().encode(text));
}

function decodeTextBase64Url(value: string) {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return new TextDecoder().decode(
        Uint8Array.from(atob(padded), char => char.charCodeAt(0)),
    );
}

async function createSessionCookie(session: AuthSession) {
    const payload = encodeTextBase64Url(JSON.stringify(session));
    return `${payload}.${await hmac(payload)}`;
}

async function readSessionCookie(c: Context): Promise<AuthSession | undefined> {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie) return undefined;

    const [payload, signature] = cookie.split(".");
    if (!payload || !signature || signature !== (await hmac(payload))) {
        return undefined;
    }

    try {
        const session = JSON.parse(decodeTextBase64Url(payload)) as AuthSession;
        if (session.expiresAt <= Date.now()) return undefined;
        if (session.user?.id !== "admin") return undefined;
        return session;
    } catch {
        return undefined;
    }
}

export async function setAuthSession(c: Context) {
    const loggedInAt = Date.now();
    const session: AuthSession = {
        user: { id: "admin" },
        loggedInAt,
        expiresAt: loggedInAt + SESSION_MAX_AGE_SECONDS * 1000,
    };

    setCookie(c, SESSION_COOKIE, await createSessionCookie(session), {
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

export async function getAuthSession(c: Context) {
    return await readSessionCookie(c);
}

export async function requireAgentazAuth(c: Context) {
    const session = await readSessionCookie(c);
    if (!session) throw unauthorizedError();
    return session;
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
