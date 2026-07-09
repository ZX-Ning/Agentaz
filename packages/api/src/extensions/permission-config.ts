import type {
    PermissionConfigResponse,
    PermissionRuleValue,
    PermissionState,
    PermissionSurfacePolicy,
    PermissionSystemConfig,
} from "@agentaz/protocol";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BadRequestError } from "../errors.ts";

const PERMISSION_SCHEMA_URL =
    "https://raw.githubusercontent.com/gotgenes/pi-permission-system/main/schemas/permissions.schema.json";

/**
 * The Pi extension identifier for the permission system.
 * Must match what the Pi SDK resolves via @gotgenes/pi-permission-system.
 */
export const PERMISSION_EXTENSION_ID = "pi-permission-system";

/**
 * Returns the expected path for the global permission-system config file.
 * Located at <agentDir>/extensions/pi-permission-system/config.json.
 */
export function getGlobalPermissionConfigPath(agentDir: string) {
    return join(
        agentDir,
        "extensions",
        PERMISSION_EXTENSION_ID,
        "config.json",
    );
}

/**
 * Returns the expected path for the project permission-system config file.
 * Located at <cwd>/.pi/extensions/pi-permission-system/config.json.
 */
export function getProjectPermissionConfigPath(cwd: string) {
    return join(
        cwd,
        ".pi",
        "extensions",
        PERMISSION_EXTENSION_ID,
        "config.json",
    );
}

/**
 * Ensures the global permission-system configuration exists in the agent
 * directory. This is idempotent and never overwrites user customizations.
 */
export async function ensurePermissionConfig(agentDir: string) {
    const configPath = getGlobalPermissionConfigPath(agentDir);

    try {
        await stat(configPath);
        // Config already exists — leave the user's customizations intact.
        return { configPath, created: false };
    }
    catch {
        // Missing config is expected on first run — create a default.
    }

    // Create the extension config directory (recursive for first-run scenarios
    // where the extensions directory itself doesn't exist yet).
    await mkdir(join(agentDir, "extensions", PERMISSION_EXTENSION_ID), {
        recursive: true,
    });

    // Write the default config as formatted JSON.
    await writePermissionConfigFile(configPath, defaultPermissionConfig());
    return { configPath, created: true };
}

/** Reads the current project's config, or returns a default template if absent. */
export async function readProjectPermissionConfig(
    cwd: string,
): Promise<PermissionConfigResponse> {
    const configPath = getProjectPermissionConfigPath(cwd);
    const loaded = await readPermissionConfigFile(configPath);

    return {
        scope: "project",
        cwd,
        configPath,
        exists: loaded.exists,
        config: loaded.config,
    };
}

/** Replaces the current project's permission config after validation. */
export async function writeProjectPermissionConfig(
    cwd: string,
    config: unknown,
): Promise<PermissionConfigResponse> {
    const configPath = getProjectPermissionConfigPath(cwd);
    const normalized = normalizePermissionConfig(config);
    await writePermissionConfigFile(configPath, normalized);

    return {
        scope: "project",
        cwd,
        configPath,
        exists: true,
        config: normalized,
    };
}

/** Deletes the current project's override so permission-system falls back. */
export async function resetProjectPermissionConfig(
    cwd: string,
): Promise<PermissionConfigResponse> {
    const configPath = getProjectPermissionConfigPath(cwd);
    await rm(configPath, { force: true });

    return {
        scope: "project",
        cwd,
        configPath,
        exists: false,
        config: defaultPermissionConfig(),
    };
}

async function readPermissionConfigFile(configPath: string) {
    try {
        const raw = await readFile(configPath, "utf8");
        return {
            exists: true,
            config: normalizePermissionConfig(JSON.parse(raw)),
        };
    }
    catch (error) {
        if (isFileMissing(error)) {
            return { exists: false, config: defaultPermissionConfig() };
        }
        if (error instanceof SyntaxError) {
            throw new BadRequestError(
                `Permission config at ${configPath} contains malformed JSON.`,
            );
        }
        throw error;
    }
}

async function writePermissionConfigFile(
    configPath: string,
    config: PermissionSystemConfig,
) {
    const tmpPath = `${configPath}.tmp-${crypto.randomUUID()}`;

    await mkdir(dirname(configPath), { recursive: true });
    try {
        await writeFile(
            tmpPath,
            `${JSON.stringify(config, null, 2)}\n`,
            "utf8",
        );
        await rename(tmpPath, configPath);
    }
    catch (error) {
        await rm(tmpPath, { force: true }).catch(() => undefined);
        throw error;
    }
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
export function defaultPermissionConfig(): PermissionSystemConfig {
    return {
        $schema: PERMISSION_SCHEMA_URL,
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

/** Validates and fills omitted runtime knobs with Agentaz defaults. */
export function normalizePermissionConfig(
    input: unknown,
): PermissionSystemConfig {
    assertPlainObject(input, "Permission config");

    const record = input as Record<string, unknown>;
    const allowedKeys = new Set([
        "$schema",
        "debugLog",
        "permissionReviewLog",
        "yoloMode",
        "toolInputPreviewMaxLength",
        "toolTextSummaryMaxLength",
        "piInfrastructureReadPaths",
        "permission",
    ]);
    for (const key of Object.keys(record)) {
        if (!allowedKeys.has(key)) {
            throw new BadRequestError(`Unknown permission config key: ${key}.`);
        }
    }

    assertPlainObject(record.permission, "permission");
    const defaults = defaultPermissionConfig();
    const normalized: PermissionSystemConfig = {
        $schema: stringOrDefault(record.$schema, defaults.$schema),
        debugLog: booleanOrDefault(record.debugLog, defaults.debugLog),
        permissionReviewLog: booleanOrDefault(
            record.permissionReviewLog,
            defaults.permissionReviewLog,
        ),
        yoloMode: booleanOrDefault(record.yoloMode, defaults.yoloMode),
        piInfrastructureReadPaths: stringArrayOrDefault(
            record.piInfrastructureReadPaths,
            defaults.piInfrastructureReadPaths,
            "piInfrastructureReadPaths",
        ),
        permission: normalizePermission(record.permission),
    };

    const inputPreviewMax = optionalPositiveInteger(
        record.toolInputPreviewMaxLength,
        "toolInputPreviewMaxLength",
    );
    if (inputPreviewMax !== undefined) {
        normalized.toolInputPreviewMaxLength = inputPreviewMax;
    }

    const textSummaryMax = optionalPositiveInteger(
        record.toolTextSummaryMaxLength,
        "toolTextSummaryMaxLength",
    );
    if (textSummaryMax !== undefined) {
        normalized.toolTextSummaryMaxLength = textSummaryMax;
    }

    return normalized;
}

function normalizePermission(input: unknown) {
    assertPlainObject(input, "permission");
    const output: Record<string, PermissionSurfacePolicy> = {};

    for (const [surface, policy] of Object.entries(input)) {
        if (!surface) {
            throw new BadRequestError(
                "Permission surface names cannot be empty.",
            );
        }
        output[surface] = normalizeSurfacePolicy(surface, policy);
    }

    return output;
}

function normalizeSurfacePolicy(surface: string, policy: unknown) {
    if (isPermissionState(policy)) {
        return policy;
    }

    assertPlainObject(policy, `permission.${surface}`);
    const output: Record<string, PermissionRuleValue> = {};
    for (const [pattern, value] of Object.entries(policy)) {
        if (!pattern) {
            throw new BadRequestError(
                `Permission pattern names cannot be empty for ${surface}.`,
            );
        }
        output[pattern] = normalizeRuleValue(surface, pattern, value);
    }
    return output;
}

function normalizeRuleValue(surface: string, pattern: string, value: unknown) {
    if (isPermissionState(value)) {
        return value;
    }

    assertPlainObject(value, `permission.${surface}.${pattern}`);
    const record = value as Record<string, unknown>;
    const extraKeys = Object.keys(record).filter((key) =>
        key !== "action" && key !== "reason"
    );
    if (extraKeys.length > 0) {
        throw new BadRequestError(
            `Unknown deny rule key: ${extraKeys[0]} in ${surface}.${pattern}.`,
        );
    }
    if (record.action !== "deny") {
        throw new BadRequestError(
            `Permission rule ${surface}.${pattern} action must be deny.`,
        );
    }
    if (record.reason !== undefined && typeof record.reason !== "string") {
        throw new BadRequestError(
            `Permission rule ${surface}.${pattern} reason must be a string.`,
        );
    }
    if (typeof record.reason === "string" && record.reason.length > 500) {
        throw new BadRequestError(
            `Permission rule ${surface}.${pattern} reason is too long.`,
        );
    }

    const deny: PermissionRuleValue = { action: "deny" };
    if (typeof record.reason === "string") {
        deny.reason = record.reason;
    }
    return deny;
}

function isPermissionState(value: unknown): value is PermissionState {
    return value === "allow" || value === "ask" || value === "deny";
}

function assertPlainObject(
    value: unknown,
    label: string,
): asserts value is object {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new BadRequestError(`${label} must be an object.`);
    }
}

function stringOrDefault(value: unknown, fallback: string | undefined) {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== "string") {
        throw new BadRequestError("$schema must be a string.");
    }
    return value;
}

function booleanOrDefault(value: unknown, fallback: boolean | undefined) {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== "boolean") {
        throw new BadRequestError("Permission config flags must be boolean.");
    }
    return value;
}

function stringArrayOrDefault(
    value: unknown,
    fallback: string[] | undefined,
    label: string,
) {
    if (value === undefined) {
        return fallback;
    }
    if (
        !Array.isArray(value) || value.some((item) => typeof item !== "string")
    ) {
        throw new BadRequestError(`${label} must be an array of strings.`);
    }
    return value;
}

function optionalPositiveInteger(value: unknown, label: string) {
    if (value === undefined) {
        return undefined;
    }
    if (!Number.isInteger(value) || Number(value) < 1) {
        throw new BadRequestError(`${label} must be a positive integer.`);
    }
    return value as number;
}

function isFileMissing(error: unknown) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
