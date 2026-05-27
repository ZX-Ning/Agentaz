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
    experimental: {
      websocket: true,
    },
  },
  runtimeConfig: {
    session: {
      maxAge: 60 * 60 * 24,
      password:
        process.env.NUXT_SESSION_PASSWORD ??
        "missing-nuxt-session-password-runtime-will-fail",
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
