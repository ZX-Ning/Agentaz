import {
    defaultPermissionConfig,
    getProjectPermissionConfigPath,
    normalizePermissionConfig,
    readProjectPermissionConfig,
    resetProjectPermissionConfig,
    writeProjectPermissionConfig,
} from "../src/extensions/permission-config.ts";
import { BadRequestError } from "../src/errors.ts";

Deno.test({
    name: "project permission config read/write/reset lifecycle",
    permissions: { read: true, write: true },
    async fn() {
        const cwd = await Deno.makeTempDir();
        try {
            const initial = await readProjectPermissionConfig(cwd);
            assertEquals(initial.exists, false);
            assertEquals(initial.config.permission.bash, "ask");

            const saved = await writeProjectPermissionConfig(cwd, {
                permission: {
                    "*": "ask",
                    bash: {
                        "*": "ask",
                        "git status": "allow",
                        "npm *": {
                            action: "deny",
                            reason: "Use deno tasks instead.",
                        },
                    },
                },
                yoloMode: false,
            });
            assertEquals(saved.exists, true);
            assertEquals(saved.config.permission["*"], "ask");

            const configPath = getProjectPermissionConfigPath(cwd);
            const raw = JSON.parse(await Deno.readTextFile(configPath));
            assertEquals(raw.permission.bash["git status"], "allow");

            const loaded = await readProjectPermissionConfig(cwd);
            assertEquals(loaded.exists, true);
            assertEquals(
                loaded.config.permission.bash,
                saved.config.permission.bash,
            );

            const reset = await resetProjectPermissionConfig(cwd);
            assertEquals(reset.exists, false);
            await assertRejects(
                () => Deno.stat(configPath),
                Deno.errors.NotFound,
            );
        }
        finally {
            await Deno.remove(cwd, { recursive: true });
        }
    },
});

Deno.test("permission config validation rejects invalid actions", () => {
    assertThrows(
        () =>
            normalizePermissionConfig({
                permission: { bash: "sometimes" },
            }),
        BadRequestError,
    );
});

Deno.test("permission config normalization fills runtime defaults", () => {
    const normalized = normalizePermissionConfig({
        permission: { read: "allow" },
    });
    const defaults = defaultPermissionConfig();

    assertEquals(normalized.$schema, defaults.$schema);
    assertEquals(normalized.permissionReviewLog, true);
    assertEquals(normalized.permission.read, "allow");
    assertEquals(normalized.piInfrastructureReadPaths, []);
});

function assertEquals(actual: unknown, expected: unknown) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `Expected ${JSON.stringify(expected)}, got ${
                JSON.stringify(actual)
            }`,
        );
    }
}

async function assertRejects(
    fn: () => Promise<unknown>,
    errorClass: new (...args: never[]) => Error,
) {
    try {
        await fn();
    }
    catch (error) {
        if (error instanceof errorClass) {
            return;
        }
        throw new Error(`Expected ${errorClass.name}, got ${String(error)}.`);
    }
    throw new Error(`Expected ${errorClass.name}.`);
}

function assertThrows(
    fn: () => unknown,
    errorClass: new (...args: never[]) => Error,
) {
    try {
        fn();
    }
    catch (error) {
        if (error instanceof errorClass) {
            return;
        }
        throw new Error(`Expected ${errorClass.name}, got ${String(error)}.`);
    }
    throw new Error(`Expected ${errorClass.name}.`);
}
