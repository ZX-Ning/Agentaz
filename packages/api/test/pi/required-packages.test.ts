import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { ensureRequiredPiPackages } from "../../src/pi/required-packages.ts";

const NODE_MODULES_ENV = "AGENTAZ_PI_NODE_MODULES_DIR";
const TODO_PACKAGE = "@juicesharp/rpiv-todo";
const PERMISSION_PACKAGE = "@gotgenes/pi-permission-system";

/**
 * Purpose: Verify first-run package setup is additive, preserves user settings,
 * and becomes byte-for-byte idempotent once required npm sources are configured.
 * Expect: Both required packages are added once while unrelated fields/packages survive.
 * Method: Seed custom settings, ensure twice, and compare parsed plus raw file contents.
 */
Deno.test("required package setup preserves settings and is idempotent", async () => {
    using _env = withEnv(NODE_MODULES_ENV, undefined);
    const agentDir = await Deno.makeTempDir();
    const settingsPath = join(agentDir, "settings.json");
    try {
        await Deno.writeTextFile(
            settingsPath,
            JSON.stringify({
                theme: "custom",
                packages: ["npm:user-package", {
                    source: "git:user/repo",
                    keep: true,
                }],
            }),
        );

        const first = await ensureRequiredPiPackages(agentDir);
        const firstRaw = await Deno.readTextFile(settingsPath);
        const firstSettings = JSON.parse(firstRaw);
        assert.deepEqual(first.added, [
            `npm:${TODO_PACKAGE}`,
            `npm:${PERMISSION_PACKAGE}`,
        ]);
        assert.equal(firstSettings.theme, "custom");
        assert.deepEqual(firstSettings.packages.slice(0, 2), [
            "npm:user-package",
            { source: "git:user/repo", keep: true },
        ]);

        const second = await ensureRequiredPiPackages(agentDir);
        assert.deepEqual(second.added, []);
        assert.equal(await Deno.readTextFile(settingsPath), firstRaw);
    }
    finally {
        await Deno.remove(agentDir, { recursive: true });
    }
});

/**
 * Purpose: Verify changing local package availability replaces only Agentaz-managed
 * alternatives and never loads duplicate local/npm copies of an extension.
 * Expect: npm sources become local roots, then return to npm when the env is removed.
 * Method: Create both package directories, toggle AGENTAZ_PI_NODE_MODULES_DIR, and inspect sources.
 */
Deno.test("required package setup switches between local and npm sources", async () => {
    const root = await Deno.makeTempDir();
    const agentDir = join(root, "agent");
    const nodeModulesDir = join(root, "node_modules");
    const todoPath = join(nodeModulesDir, TODO_PACKAGE);
    const permissionPath = join(nodeModulesDir, PERMISSION_PACKAGE);
    await Deno.mkdir(todoPath, { recursive: true });
    await Deno.mkdir(permissionPath, { recursive: true });
    await Deno.mkdir(agentDir, { recursive: true });
    await Deno.writeTextFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
            packages: [
                `npm:${TODO_PACKAGE}`,
                `npm:${PERMISSION_PACKAGE}`,
                "npm:user-package",
            ],
        }),
    );

    try {
        {
            using _env = withEnv(NODE_MODULES_ENV, nodeModulesDir);
            await ensureRequiredPiPackages(agentDir);
            const packages = await packageSources(agentDir);
            assert.deepEqual(packages, [
                "npm:user-package",
                resolve(todoPath),
                resolve(permissionPath),
            ]);
        }

        {
            using _env = withEnv(NODE_MODULES_ENV, undefined);
            await ensureRequiredPiPackages(agentDir);
            const packages = await packageSources(agentDir);
            assert.deepEqual(packages, [
                "npm:user-package",
                `npm:${TODO_PACKAGE}`,
                `npm:${PERMISSION_PACKAGE}`,
            ]);
        }
    }
    finally {
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Verify partial local installs fall back predictably and corrupted settings
 * fail loudly instead of being silently replaced.
 * Expect: Missing local packages warn/use npm; malformed JSON and packages shape reject.
 * Method: Exercise one partial node_modules tree, then write two invalid settings files.
 */
Deno.test("required package setup handles partial and invalid configuration", async () => {
    using warnings = captureConsoleWarnings();
    const root = await Deno.makeTempDir();
    const agentDir = join(root, "agent");
    const nodeModulesDir = join(root, "node_modules");
    await Deno.mkdir(join(nodeModulesDir, TODO_PACKAGE), { recursive: true });

    try {
        {
            using _env = withEnv(NODE_MODULES_ENV, nodeModulesDir);
            await ensureRequiredPiPackages(agentDir);
        }
        assert.deepEqual(await packageSources(agentDir), [
            resolve(join(nodeModulesDir, TODO_PACKAGE)),
            `npm:${PERMISSION_PACKAGE}`,
        ]);
        assert.equal(warnings.messages.length, 1);
        assert.match(String(warnings.messages[0]?.[0]), /pi-permission-system/);

        await Deno.writeTextFile(join(agentDir, "settings.json"), "{invalid");
        await assert.rejects(
            () => ensureRequiredPiPackages(agentDir),
            SyntaxError,
        );

        await Deno.writeTextFile(
            join(agentDir, "settings.json"),
            JSON.stringify({ packages: { source: "npm:invalid" } }),
        );
        await assert.rejects(
            () => ensureRequiredPiPackages(agentDir),
            /Invalid Pi settings packages field/,
        );
    }
    finally {
        await Deno.remove(root, { recursive: true });
    }
});

async function packageSources(agentDir: string) {
    const settings = JSON.parse(
        await Deno.readTextFile(join(agentDir, "settings.json")),
    ) as { packages: Array<string | { source?: string }> };
    return settings.packages.map((entry) =>
        typeof entry === "string" ? entry : entry.source
    );
}

function withEnv(name: string, value: string | undefined) {
    const previous = Deno.env.get(name);
    if (value === undefined) {
        Deno.env.delete(name);
    }
    else {
        Deno.env.set(name, value);
    }
    return {
        [Symbol.dispose]() {
            if (previous === undefined) {
                Deno.env.delete(name);
            }
            else {
                Deno.env.set(name, previous);
            }
        },
    };
}

function captureConsoleWarnings() {
    const original = console.warn;
    const messages: unknown[][] = [];
    console.warn = (...args: unknown[]) => messages.push(args);
    return {
        messages,
        [Symbol.dispose]() {
            console.warn = original;
        },
    };
}
