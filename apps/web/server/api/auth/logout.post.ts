/**
 * POST /api/auth/logout
 *
 * Clears the current nuxt-auth-utils session cookie.
 *
 * Request body: none
 *
 * Response (200):
 *   - ok: true
 *
 * Side effects:
 *   - Removes the browser's encrypted session cookie.
 *
 * Errors:
 *   - 401: No valid auth session is present
 */
export default defineEventHandler(async (event) => {
  await clearUserSession(event);
  return { ok: true };
});
