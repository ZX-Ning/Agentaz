import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The Pi extension identifier for the permission system.
 * Must match what the Pi SDK resolves via @gotgenes/pi-permission-system.
 */
export const PERMISSION_EXTENSION_ID = "pi-permission-system";

/**
 * Returns the expected path for the permission-system config file.
 * Located at <agentDir>/extensions/pi-permission-system/config.json.
 */
export function getGlobalPermissionConfigPath(agentDir: string) {
    return join(agentDir, "extensions", PERMISSION_EXTENSION_ID, "config.json");
}

/**
 * Ensures the permission-system configuration exists in the agent directory.
 *
 * On first run, creates the config directory and writes a default configuration
 * that balances safety with usability:
 *   - Read-only tools (read, grep, find, ls) are allowed by default.
 *   - Mutating tools (bash, edit, write) require browser approval.
 *   - Environment files (*.env, *.env.*) are denied, except *.env.example.
 *   - External directory access requires approval.
 *   - YOLO mode is off.
 *
 * Returns { configPath, created } — created is true when the config was
 * newly written, false when it already existed.
 *
 * This is idempotent: calling it repeatedly won't overwrite an existing
 * user-customized configuration.
 */
export async function ensurePermissionConfig(agentDir: string) {
    const configPath = getGlobalPermissionConfigPath(agentDir);

    try {
        await stat(configPath);
        // Config already exists — leave the user's customizations intact.
        return { configPath, created: false };
    } catch {
        // Missing config is expected on first run — create a default.
    }

    // Create the extension config directory (recursive for first-run scenarios
    // where the extensions directory itself doesn't exist yet).
    await mkdir(join(agentDir, "extensions", PERMISSION_EXTENSION_ID), {
        recursive: true,
    });

    // Write the default config as formatted JSON.
    await writeFile(
        configPath,
        `${JSON.stringify(defaultPermissionConfig(), null, 2)}\n`,
        "utf8",
    );
    return { configPath, created: true };
}

/**
 * Returns the default permission configuration for the permission-system extension.
 *
 * Tool permissions are categorized by safety:
 *   - allow: read, grep, find, ls (read-only, non-destructive)
 *   - ask:  bash, edit, write (potentially destructive, requires browser approval)
 *
 * File path rules provide an extra layer: .env files are blocked even for
 * read-only tools to prevent credential leaks.
 */
function defaultPermissionConfig() {
    return {
        $schema:
            "https://raw.githubusercontent.com/gotgenes/pi-permission-system/main/schemas/permissions.schema.json",
        debugLog: false,
        permissionReviewLog: true,
        yoloMode: false,
        piInfrastructureReadPaths: [],
        permission: {
            // Default for any tool not explicitly listed.
            "*": "allow",
            // Read-only tools: always allowed (non-destructive).
            read: "allow",
            grep: "allow",
            find: "allow",
            ls: "allow",
            // Mutating tools: require browser approval.
            bash: "ask",
            edit: "ask",
            write: "ask",
            // Path-based restrictions override per-tool defaults.
            path: {
                "*": "allow",
                "*.env": "deny",
                "*.env.*": "deny",
                // Allow example env files for reference.
                "*.env.example": "allow",
            },
            // External directory access: require explicit approval.
            external_directory: "ask",
        },
    };
}
