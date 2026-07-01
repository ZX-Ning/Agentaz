import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, rootDir, "");
    const apiTarget = env.VITE_AGENTAZ_API_TARGET ||
        env.AGENTAZ_API_TARGET ||
        "http://127.0.0.1:3000";

    return {
        plugins: [vue(), tailwindcss()],
        server: {
            proxy: {
                "/api": {
                    target: apiTarget,
                    changeOrigin: true,
                },
            },
        },
        resolve: {
            alias: {
                "~": fileURLToPath(new URL("./src", import.meta.url)),
                "@": fileURLToPath(new URL("./src", import.meta.url)),
                "@agentaz/protocol": fileURLToPath(
                    new URL("../protocol/mod.ts", import.meta.url),
                ),
            },
        },
    };
});
