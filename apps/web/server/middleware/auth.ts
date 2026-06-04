import { requireAgentazAuth } from "../utils/auth";

/**
 * Returns whether the given request path targets a public API endpoint
 * that must remain unauthenticated.  Uses suffix matching so the check
 * stays correct regardless of an optional `app.baseURL` prefix.
 */
function isPublicApiPath(path: string): boolean {
  return (
    path.endsWith("/api/auth/login") || path.endsWith("/api/_auth/session")
  );
}

/**
 * Global API authentication middleware.
 *
 * Protects every API endpoint, including /api/health and /api/agent/**. The
 * only exceptions are the login endpoint and nuxt-auth-utils' session endpoint,
 * which must stay public so the frontend can determine whether a cookie already
 * represents a valid session.
 *
 * Uses `includes("/api/")` instead of `startsWith` so the check remains
 * correct when `app.baseURL` has a non-root prefix (e.g. /agentaz).
 */
export default defineEventHandler(async (event) => {
  const path = event.path.split("?")[0] ?? "/";
  if (!path.includes("/api/")) return;
  if (isPublicApiPath(path)) return;

  await requireAgentazAuth(event);
});
