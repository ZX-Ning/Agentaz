export default defineNuxtConfig({
  compatibilityDate: "2026-05-22",
  devtools: { enabled: true },
  ssr: false,
  modules: [
    "@nuxt/ui",
    "@comark/nuxt",
    "@nuxt/eslint",
    "nuxt-auth-utils",
    "@nuxtjs/color-mode",
  ],
  css: [
    "@fontsource-variable/ibm-plex-sans",
    "@fontsource-variable/ibm-plex-sans/wdth-italic.css",
    "~/assets/css/main.css",
  ],
  nitro: {
    minify: true,
    sourceMap: false,
  },
  runtimeConfig: {
    session: {
      maxAge: 60 * 60 * 24,
      password:
        process.env.NUXT_SESSION_PASSWORD ??
        "missing-nuxt-session-password-runtime-will-fail",
      /**
       * h3's DEFAULT_COOKIE hardcodes secure: true, which prevents session
       * cookies from being sent over HTTP on non-localhost addresses (RFC 6265
       * only exempts localhost for Secure cookies). Override to false so the
       * session works over plain HTTP on LAN / remote addresses. Deployments
       * behind HTTPS should override via env or runtime config.
       */
      cookie: {
        secure: false,
      },
    },
    piWeb: {
      cwd: process.env.PI_WEB_CWD ?? process.cwd(),
      approvalTimeoutMs: Number(
        process.env.PI_WEB_APPROVAL_TIMEOUT_MS ?? 5 * 60 * 1000,
      ),
      maxLoadedSessions: Number(process.env.PI_WEB_MAX_LOADED_SESSIONS ?? 5),
    },
  },
});
