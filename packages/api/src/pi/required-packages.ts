import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const REQUIRED_PI_NODE_MODULES_DIR_ENV = "AGENTAZ_PI_NODE_MODULES_DIR";

/** Pi SDK extension packages that Agentaz requires for correct operation. */
const REQUIRED_PI_PACKAGES = [
    {
        name: "@juicesharp/rpiv-todo",
        npmSource: "npm:@juicesharp/rpiv-todo",
    },
    {
        name: "@gotgenes/pi-permission-system",
        npmSource: "npm:@gotgenes/pi-permission-system",
    },
] as const;

/**
 * Shape of the Pi agent's settings.json file.
 * We only care about the packages field — other properties are preserved as-is.
 */
type PiSettings = {
    packages?: Array<string | { source?: string; [key: string]: unknown }>;
    [key: string]: unknown;
};

type RequiredPackageSource = {
    /** Package name under node_modules. */
    name: string;
    /** Source that should be present in Pi settings. */
    source: string;
    /** npm fallback source for diagnostics and managed-source replacement. */
    npmSource: string;
    /** Local package root under AGENTAZ_PI_NODE_MODULES_DIR, when configured. */
    localSource?: string;
};

/**
 * Ensures Agentaz's required Pi extension packages are listed in the global
 * Pi agent settings.json.
 *
 * Source selection:
 *   - If AGENTAZ_PI_NODE_MODULES_DIR points at a node_modules directory and the
 *     required package exists there, write that local package path.
 *   - Otherwise write the package's npm: source so Pi can install it normally.
 *
 * This is idempotent and non-destructive for unrelated packages. When the env
 * var changes, this function replaces Agentaz-managed alternatives for the same
 * required package (local path <-> npm:) to avoid loading duplicate extensions.
 *
 * Returns { settingsPath, added } — added is the list of package sources that
 * were newly appended (empty when all packages were pre-configured).
 */
export async function ensureRequiredPiPackages(agentDir: string) {
    const settingsPath = join(agentDir, "settings.json");
    const requiredSources = await resolveRequiredPackageSources();

    // Read existing settings (or get empty object if file doesn't exist).
    const settings = await readPiSettings(settingsPath);
    const packages = settings.packages ?? [];

    const desired = new Set(requiredSources.map((entry) => entry.source));

    // Remove only Agentaz-managed alternatives for these required packages when
    // they are not the selected source. Preserve every unrelated user package.
    const keptPackages = packages.filter((entry) => {
        const source = getPackageSource(entry);
        return !source || desired.has(source) ||
            !isRequiredPackageAlternative(source, requiredSources);
    });

    const configured = new Set(
        keptPackages
            .map((entry) => getPackageSource(entry))
            .filter((source): source is string => Boolean(source)),
    );

    const missing = requiredSources
        .map((entry) => entry.source)
        .filter((source) => !configured.has(source));

    const nextPackages = [...keptPackages, ...missing];
    const changed = missing.length > 0 ||
        nextPackages.length !== packages.length ||
        nextPackages.some((entry, index) => entry !== packages[index]);

    if (!changed) {
        return { settingsPath, added: [] as string[] };
    }

    const nextSettings: PiSettings = {
        ...settings,
        packages: nextPackages,
    };

    // Ensure the agent directory exists before writing.
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
        settingsPath,
        `${JSON.stringify(nextSettings, null, 2)}\n`,
    );

    return { settingsPath, added: [...missing] };
}

async function resolveRequiredPackageSources(): Promise<
    RequiredPackageSource[]
> {
    const nodeModulesDir = process.env[REQUIRED_PI_NODE_MODULES_DIR_ENV]
        ?.trim();
    if (!nodeModulesDir) {
        return REQUIRED_PI_PACKAGES.map((pkg) => ({
            name: pkg.name,
            source: pkg.npmSource,
            npmSource: pkg.npmSource,
        }));
    }

    const resolvedNodeModulesDir = resolve(nodeModulesDir);
    return Promise.all(
        REQUIRED_PI_PACKAGES.map(async (pkg) => {
            const localSource = join(resolvedNodeModulesDir, pkg.name);
            if (await isDirectory(localSource)) {
                return {
                    name: pkg.name,
                    source: localSource,
                    npmSource: pkg.npmSource,
                    localSource,
                };
            }

            console.warn(
                `[agentaz-server] ${REQUIRED_PI_NODE_MODULES_DIR_ENV} is set, ` +
                    `but ${pkg.name} was not found at ${localSource}; ` +
                    `falling back to ${pkg.npmSource}`,
            );
            return {
                name: pkg.name,
                source: pkg.npmSource,
                npmSource: pkg.npmSource,
                localSource,
            };
        }),
    );
}

function getPackageSource(
    entry: string | { source?: string; [key: string]: unknown },
) {
    return typeof entry === "string" ? entry : entry.source;
}

function isRequiredPackageAlternative(
    source: string,
    requiredSources: RequiredPackageSource[],
) {
    return requiredSources.some((entry) =>
        source === entry.npmSource || source === entry.localSource ||
        isLocalPackageRootSource(source, entry.name)
    );
}

function isLocalPackageRootSource(source: string, packageName: string) {
    if (
        source.startsWith("npm:") || source.startsWith("git:") ||
        /^[a-z]+:\/\//i.test(source)
    ) {
        return false;
    }

    const normalizedSource = source.replaceAll("\\", "/").replace(/\/+$/, "");
    return normalizedSource === packageName ||
        normalizedSource.endsWith(`/${packageName}`);
}

async function isDirectory(path: string) {
    try {
        return (await stat(path)).isDirectory();
    }
    catch (error) {
        if (
            error && typeof error === "object" && "code" in error &&
            error.code === "ENOENT"
        ) {
            return false;
        }
        throw error;
    }
}

/**
 * Reads the Pi agent's settings.json file.
 *
 * Validates that the packages field is an array if present.
 * Returns an empty object if the file doesn't exist (ENOENT).
 * Re-throws all other errors.
 */
async function readPiSettings(settingsPath: string): Promise<PiSettings> {
    try {
        const settings = JSON.parse(
            await readFile(settingsPath, "utf8"),
        ) as PiSettings;

        // Validate the packages field to catch corrupted settings files early.
        if (
            settings.packages !== undefined &&
            !Array.isArray(settings.packages)
        ) {
            throw new Error(
                `Invalid Pi settings packages field at ${settingsPath}`,
            );
        }
        return settings;
    }
    catch (error) {
        // ENOENT is expected on first run — the file will be created.
        if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            return {};
        }
        throw error;
    }
}
