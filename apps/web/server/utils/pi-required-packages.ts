import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const REQUIRED_PI_PACKAGE_SOURCES = [
  "npm:@juicesharp/rpiv-todo",
  "npm:@gotgenes/pi-permission-system",
] as const;

type PiSettings = {
  packages?: Array<string | { source?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

/** Ensures global Pi settings include Agentaz's required extensions. */
export async function ensureRequiredPiPackages(agentDir: string) {
  const settingsPath = join(agentDir, "settings.json");
  const settings = await readPiSettings(settingsPath);
  const packages = settings.packages ?? [];
  const configured = new Set(
    packages
      .map((entry) => (typeof entry === "string" ? entry : entry.source))
      .filter((source): source is string => Boolean(source)),
  );
  const missing = REQUIRED_PI_PACKAGE_SOURCES.filter(
    (source) => !configured.has(source),
  );

  if (missing.length === 0) {
    return { settingsPath, added: [] as string[] };
  }

  const nextSettings: PiSettings = {
    ...settings,
    packages: [...packages, ...missing],
  };
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`);
  return { settingsPath, added: [...missing] };
}

async function readPiSettings(settingsPath: string): Promise<PiSettings> {
  try {
    const settings = JSON.parse(
      await readFile(settingsPath, "utf8"),
    ) as PiSettings;
    if (settings.packages !== undefined && !Array.isArray(settings.packages)) {
      throw new Error(`Invalid Pi settings packages field at ${settingsPath}`);
    }
    return settings;
  } catch (error) {
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
