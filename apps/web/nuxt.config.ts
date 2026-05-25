export default defineNuxtConfig({
  compatibilityDate: '2026-05-22',
  devtools: { enabled: true },
  modules: ['@nuxt/ui', '@comark/nuxt'],
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,100..700;1,100..700&display=swap',
        },
      ],
    },
  },
  nitro: {
    experimental: {
      websocket: true,
    },
  },
  runtimeConfig: {
    piWeb: {
      cwd: process.env.PI_WEB_CWD || process.cwd(),
      approvalTimeoutMs: Number(process.env.PI_WEB_APPROVAL_TIMEOUT_MS || 5 * 60 * 1000),
      maxLoadedSessions: Number(process.env.PI_WEB_MAX_LOADED_SESSIONS || 5),
      allowNonLocalhost: process.env.HOST && !['127.0.0.1', 'localhost'].includes(process.env.HOST),
    },
  },
})
