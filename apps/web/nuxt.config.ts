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
                "missing-nuxt-session-password-runtime-will-generate",
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
            /**
             * Default working directory for Pi sessions.
             *
             * This value is baked into the build at build time and acts as a
             * fallback. The server startup plugin reads PI_WEB_CWD and
             * PI_WEB_APPROVAL_TIMEOUT_MS / PI_WEB_MAX_LOADED_SESSIONS at
             * runtime and overrides these defaults accordingly.
             *
             * An empty string signals "no build-time override" so the startup
             * plugin falls through to process.cwd() at runtime.
             */
            cwd: "",
            /** Default 5-minute timeout for browser-backed approval prompts. */
            approvalTimeoutMs: 5 * 60 * 1000,
            /** Default maximum number of simultaneously loaded Pi sessions. */
            maxLoadedSessions: 5,
        },
    },
});
