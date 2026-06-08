import { createHash, timingSafeEqual } from "node:crypto";
import { createError } from "h3";

/** Environment variable containing base64(SHA3-256(admin password)). */
const ADMIN_PASSWORD_HASH_ENV = "AGENTAZ_ADMIN_PASSWORD_HASH";

/** Environment variable used by nuxt-auth-utils to encrypt session cookies. */
const SESSION_PASSWORD_ENV = "NUXT_SESSION_PASSWORD";

/** Minimum length required by nuxt-auth-utils for the session password. */
const MIN_SESSION_PASSWORD_LENGTH = 32;

/**
 * Returns the configured admin password hash or throws a startup/request error.
 *
 * The hash is deliberately kept separate from NUXT_SESSION_PASSWORD. The former
 * verifies the user-entered password, while the latter encrypts the auth cookie.
 */
export function requireAdminPasswordHash() {
  const hash = process.env[ADMIN_PASSWORD_HASH_ENV]?.trim();
  if (!hash) {
    throw new Error(`${ADMIN_PASSWORD_HASH_ENV} must be provided.`);
  }
  return hash;
}

/**
 * Validates auth-related environment variables during Nitro startup.
 *
 * This fails closed before the Pi runtime is exposed. nuxt-auth-utils can create
 * a development session password automatically, but Agentaz requires an explicit
 * NUXT_SESSION_PASSWORD so deployments do not accidentally rely on generated
 * local state.
 */
export function assertAuthConfig() {
  requireAdminPasswordHash();
  const sessionPassword = process.env[SESSION_PASSWORD_ENV];
  if (!sessionPassword) {
    throw new Error(`${SESSION_PASSWORD_ENV} must be provided.`);
  }
  if (sessionPassword.length < MIN_SESSION_PASSWORD_LENGTH) {
    throw new Error(
      `${SESSION_PASSWORD_ENV} must be at least ${MIN_SESSION_PASSWORD_LENGTH} characters.`,
    );
  }
}

/**
 * Computes base64(SHA3-256(password)) for the exact UTF-8 password string.
 *
 * This matches the configured AGENTAZ_ADMIN_PASSWORD_HASH format and avoids
 * storing the plaintext admin password in process environment variables.
 */
export function hashAdminPassword(password: string) {
  return createHash("sha3-256").update(password, "utf8").digest("base64");
}

/**
 * Compares a submitted password with the configured admin password hash.
 *
 * Returns false for malformed configured hashes instead of leaking validation
 * details to the login route. Startup validation still ensures the variable is
 * present; this function handles equality only.
 */
export function verifyAdminPassword(password: string) {
  const expected = Buffer.from(requireAdminPasswordHash(), "base64");
  const actual = Buffer.from(hashAdminPassword(password), "base64");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Throws a structured 401 response for unauthenticated API requests.
 *
 * The payload shape matches the existing agent HTTP errors so frontend fetch
 * handling can display a consistent message.
 */
export function unauthorizedError(message = "Authentication required.") {
  return createError({
    statusCode: 401,
    statusMessage: message,
    data: {
      code: "unauthorized",
      message,
      recoverable: true,
    },
  });
}

/**
 * Requires a nuxt-auth-utils user session and normalizes failed checks.
 *
 * Middleware and API/SSE handlers use this wrapper so protected surfaces return
 * the same recoverable 401 payload.
 */
export async function requireAgentazAuth(
  event: Parameters<typeof requireUserSession>[0],
) {
  try {
    return await requireUserSession(event);
  } catch {
    throw unauthorizedError();
  }
}
