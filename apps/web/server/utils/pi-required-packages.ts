import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Pi SDK extension packages that Agentaz requires for correct operation.
 *
 * These are automatically added to the Pi agent's settings.json on first startup.
 * Each entry is an npm package specifier that the Pi SDK will resolve and load
 * as an extension:
 *   - @juicesharp/rpiv-todo: Task/todo list management extension.
 *   - @gotgenes/pi-permission-system: Permission gating for tool access.
 */
const REQUIRED_PI_PACKAGE_SOURCES = [
  "npm:@juicesharp/rpiv-todo",
  "npm:@gotgenes/pi-permission-system",
] as const;

/**
 * Shape of the Pi agent's settings.json file.
 * We only care about the packages field — other properties are preserved as-is.
 */
type PiSettings = {
  packages?: Array<string | { source?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

/**
 * Ensures Agentaz's required Pi extension packages are listed in the global
 * Pi agent settings.json.
 *
 * This is idempotent and non-destructive:
 *   1. Reads the existing settings.json (treating a missing file as empty).
 *   2. Checks which required packages are missing from the packages array.
 *   3. If all are already present, returns without writing.
 *   4. Otherwise, appends only the missing packages and writes the file.
 *
 * Returns { settingsPath, added } — added is the list of packages that were
 * newly appended (empty when all packages were pre-configured).
 *
 * Pi SDK package entries support both string and object forms; this function
 * normalizes them to extract the source for comparison but preserves the
 * original format when appending new string entries.
 */
export async function ensureRequiredPiPackages(agentDir: string) {
  const settingsPath = join(agentDir, "settings.json");

  // Read existing settings (or get empty object if file doesn't exist).
  const settings = await readPiSettings(settingsPath);

  // Normalize existing package entries to extract their source identifiers.
  const packages = settings.packages ?? [];
  const configured = new Set(
    packages
      .map((entry) => (typeof entry === "string" ? entry : entry.source))
      .filter((source): source is string => Boolean(source)),
  );

  // Determine which required packages are missing.
  const missing = REQUIRED_PI_PACKAGE_SOURCES.filter(
    (source) => !configured.has(source),
  );

  // All packages already configured — no write needed.
  if (missing.length === 0) {
    return { settingsPath, added: [] as string[] };
  }

  // Merge missing packages into the existing packages array, preserving
  // the original entries and appending only the new sources.
  const nextSettings: PiSettings = {
    ...settings,
    packages: [...packages, ...missing],
  };

  // Ensure the agent directory exists before writing.
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`);

  return { settingsPath, added: [...missing] };
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
    if (settings.packages !== undefined && !Array.isArray(settings.packages)) {
      throw new Error(`Invalid Pi settings packages field at ${settingsPath}`);
    }
    return settings;
  } catch (error) {
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
