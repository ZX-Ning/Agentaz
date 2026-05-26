export default defineNuxtConfig({
  compatibilityDate: "2026-05-22",
  devtools: { enabled: true },
  modules: ["@nuxt/ui", "@comark/nuxt"],
  css: [
    "@fontsource-variable/ibm-plex-sans",
    "@fontsource-variable/ibm-plex-sans/wdth-italic.css",
    "~/assets/css/main.css",
  ],
  routeRules: {
    "/": { ssr: false },
  },
  nitro: {
    experimental: {
      websocket: true,
    },
  },
  runtimeConfig: {
    piWeb: {
      cwd: process.env.PI_WEB_CWD || process.cwd(),
      approvalTimeoutMs: Number(
        process.env.PI_WEB_APPROVAL_TIMEOUT_MS || 5 * 60 * 1000,
      ),
      maxLoadedSessions: Number(process.env.PI_WEB_MAX_LOADED_SESSIONS || 5),
    },
  },
});
