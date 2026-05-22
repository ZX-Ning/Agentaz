export default defineNuxtConfig({
  compatibilityDate: '2026-05-22',
  devtools: { enabled: true },
  nitro: {
    experimental: {
      websocket: true,
    },
  },
  runtimeConfig: {
    piWeb: {
      cwd: process.env.PI_WEB_CWD || process.cwd(),
      approvalTimeoutMs: Number(process.env.PI_WEB_APPROVAL_TIMEOUT_MS || 5 * 60 * 1000),
      allowNonLocalhost: process.env.HOST && !['127.0.0.1', 'localhost'].includes(process.env.HOST),
    },
  },
})
