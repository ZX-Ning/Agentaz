import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PERMISSION_EXTENSION_ID = "pi-permission-system";

export function getProjectPermissionConfigPath(cwd: string) {
  return join(cwd, ".pi", "extensions", PERMISSION_EXTENSION_ID, "config.json");
}

export async function ensurePermissionConfig(cwd: string) {
  const configPath = getProjectPermissionConfigPath(cwd);

  try {
    await stat(configPath);
    return { configPath, created: false };
  } catch {
    // Missing config is expected on first run.
  }

  await mkdir(join(cwd, ".pi", "extensions", PERMISSION_EXTENSION_ID), {
    recursive: true,
  });
  await writeFile(
    configPath,
    `${JSON.stringify(defaultPermissionConfig(), null, 2)}\n`,
    "utf8",
  );
  return { configPath, created: true };
}

function defaultPermissionConfig() {
  return {
    $schema:
      "https://raw.githubusercontent.com/gotgenes/pi-permission-system/main/schemas/permissions.schema.json",
    debugLog: false,
    permissionReviewLog: true,
    yoloMode: false,
    piInfrastructureReadPaths: [],
    permission: {
      "*": "allow",
      read: "allow",
      grep: "allow",
      find: "allow",
      ls: "allow",
      bash: "ask",
      edit: "ask",
      write: "ask",
      path: {
        "*": "allow",
        "*.env": "deny",
        "*.env.*": "deny",
        "*.env.example": "allow",
      },
      external_directory: "ask",
    },
  };
}
