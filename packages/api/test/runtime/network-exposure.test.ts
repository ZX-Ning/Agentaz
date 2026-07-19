import assert from "node:assert/strict";
import { warnForNetworkExposure } from "../../src/main.ts";

Deno.test({
    name: "server warns only for bind hosts beyond loopback",
    permissions: { env: true, read: true },
    fn() {
        const previous = Deno.env.get("AGENTAZ_BIND_HOST");
        const originalWarn = console.warn;
        const warnings: unknown[][] = [];
        console.warn = (...args: unknown[]) => warnings.push(args);
        try {
            for (const host of ["127.0.0.1", "localhost", "::1"]) {
                Deno.env.set("AGENTAZ_BIND_HOST", host);
                warnForNetworkExposure();
            }
            assert.equal(warnings.length, 0);

            Deno.env.set("AGENTAZ_BIND_HOST", "0.0.0.0");
            warnForNetworkExposure();
            assert.equal(warnings.length, 1);
            assert.match(String(warnings[0]?.[0]), /WARNING.*0\.0\.0\.0/);
        }
        finally {
            console.warn = originalWarn;
            if (previous === undefined) {
                Deno.env.delete("AGENTAZ_BIND_HOST");
            }
            else {
                Deno.env.set("AGENTAZ_BIND_HOST", previous);
            }
        }
    },
});
