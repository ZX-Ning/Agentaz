/**
 * Client-side route guard for the SPA shell.
 *
 * Login is the only public browser route. All other routes render the protected
 * agent workspace, so unauthenticated navigation is redirected to /login with a
 * same-origin return path.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const { loggedIn, fetch: refreshUserSession } = useUserSession();

  await refreshUserSession();

  const isLoginRoute = to.path === "/login";
  if (!loggedIn.value && !isLoginRoute) {
    return navigateTo(
      {
        path: "/login",
        query: to.fullPath === "/" ? undefined : { redirect: to.fullPath },
      },
      { replace: true },
    );
  }

  if (loggedIn.value && isLoginRoute) {
    const rawRedirect = to.query.redirect;
    const redirect = Array.isArray(rawRedirect) ? rawRedirect[0] : rawRedirect;
    if (
      typeof redirect === "string" &&
      redirect.startsWith("/") &&
      !redirect.startsWith("//") &&
      redirect !== "/login"
    ) {
      return navigateTo(redirect, { replace: true });
    }
    return navigateTo("/", { replace: true });
  }
});
