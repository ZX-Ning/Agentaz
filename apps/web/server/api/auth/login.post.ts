import type {
    AuthLoginRequest,
    AuthLoginResponse,
} from "../../../types/protocol";
import { createError } from "h3";
import { readJsonBody } from "../../utils/agent-http";
import { unauthorizedError, verifyAdminPassword } from "../../utils/auth";

/**
 * POST /api/auth/login
 *
 * Authenticates the single Agentaz admin user and creates an encrypted
 * nuxt-auth-utils session cookie.
 *
 * Request body (JSON): AuthLoginRequest
 *   - password: Plaintext password entered by the user. It is hashed as
 *     base64(SHA3-256(password)) and compared with AGENTAZ_ADMIN_PASSWORD_HASH.
 *
 * Response (200): AuthLoginResponse
 *   - ok: true
 *   - user.id: "admin"
 *   - loggedInAt: Unix epoch milliseconds for display/debugging
 *
 * Side effects:
 *   - Sets the HTTP-only nuxt-auth-utils session cookie.
 *
 * Errors:
 *   - 400: Missing password
 *   - 401: Password does not match the configured admin hash
 *   - 500: Auth environment is not configured correctly
 */
export default defineEventHandler(async (event): Promise<AuthLoginResponse> => {
    const body = await readJsonBody<AuthLoginRequest>(event);
    if (!body.password) {
        throw createError({
            statusCode: 400,
            statusMessage: "Password is required.",
            data: {
                code: "bad_request",
                message: "Password is required.",
                recoverable: true,
            },
        });
    }

    if (!verifyAdminPassword(body.password)) {
        throw unauthorizedError("Invalid password.");
    }

    const loggedInAt = Date.now();
    const user = { id: "admin" as const };
    await setUserSession(event, { user, loggedInAt });

    return {
        ok: true,
        user,
        loggedInAt,
    };
});
