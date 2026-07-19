import assert from "node:assert/strict";
import { createApp } from "../../src/main.ts";

/**
 * Purpose: Keep SPA shell reads off the request hot path without sharing cache
 * state across separately composed app instances.
 * Expect: One app keeps its first shell while a second app reads the new file.
 * Method: Count injected reads before and after replacing the temporary index.
 */
Deno.test("createApp caches the SPA shell per app instance", async () => {
    const staticDir = await Deno.makeTempDir({ prefix: "agentaz-shell-" });
    try {
        const indexPath = `${staticDir}/index.html`;
        await Deno.writeTextFile(indexPath, "<main>first</main>");
        let reads = 0;
        const readTextFile = (path: string) => {
            reads += 1;
            return Deno.readTextFile(path);
        };
        const firstApp = createApp({ staticDir, readTextFile });

        assert.equal(
            await (await browserGet(firstApp, "/one")).text(),
            "<main>first</main>",
        );
        await Deno.writeTextFile(indexPath, "<main>second</main>");
        assert.equal(
            await (await browserGet(firstApp, "/two")).text(),
            "<main>first</main>",
        );

        const secondApp = createApp({ staticDir, readTextFile });
        assert.equal(
            await (await browserGet(secondApp, "/three")).text(),
            "<main>second</main>",
        );
        assert.equal(reads, 2);
    }
    finally {
        await Deno.remove(staticDir, { recursive: true });
    }
});

/**
 * Purpose: Avoid permanently caching a transient index.html read failure.
 * Expect: The first request returns 500 and the next request retries successfully.
 * Method: Inject one failed read followed by the real filesystem reader.
 */
Deno.test("createApp retries a failed SPA shell read", async () => {
    const staticDir = await Deno.makeTempDir({ prefix: "agentaz-shell-" });
    const originalError = console.error;
    console.error = () => {};
    try {
        await Deno.writeTextFile(
            `${staticDir}/index.html`,
            "<main>ready</main>",
        );
        let reads = 0;
        const app = createApp({
            staticDir,
            readTextFile: (path) => {
                reads += 1;
                return reads === 1
                    ? Promise.reject(new Error("temporary read failure"))
                    : Deno.readTextFile(path);
            },
        });

        const failed = await browserGet(app, "/first");
        assert.equal(failed.status, 500);
        assert.deepEqual(await failed.json(), {
            code: "agent_error",
            message: "Unexpected server error.",
            recoverable: false,
        });

        const recovered = await browserGet(app, "/second");
        assert.equal(recovered.status, 200);
        assert.equal(await recovered.text(), "<main>ready</main>");
        assert.equal(reads, 2);
    }
    finally {
        console.error = originalError;
        await Deno.remove(staticDir, { recursive: true });
    }
});

function browserGet(
    app: ReturnType<typeof createApp>,
    pathname: string,
) {
    return app.request(`http://localhost${pathname}`, {
        headers: { accept: "text/html" },
    });
}
