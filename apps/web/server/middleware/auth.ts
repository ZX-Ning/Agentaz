import { requireAgentazAuth } from "../utils/auth";

/** API paths that must remain public so the browser can discover/login. */
const PUBLIC_API_PATHS = new Set(["/api/auth/login", "/api/_auth/session"]);

/**
 * Global API authentication middleware.
 *
 * Protects every API endpoint, including /api/health and /api/agent/**. The
 * only exceptions are the login endpoint and nuxt-auth-utils' session endpoint,
 * which must stay public so the frontend can determine whether a cookie already
 * represents a valid session.
 */
export default defineEventHandler(async (event) => {
  const path = event.path.split("?")[0] ?? "/";
  if (!path.startsWith("/api/")) return;
  if (PUBLIC_API_PATHS.has(path)) return;

  await requireAgentazAuth(event);
});
