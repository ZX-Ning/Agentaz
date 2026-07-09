import type {
    PermissionConfigResponse,
    PermissionConfigSetRequest,
    PermissionSystemConfig,
} from "@agentaz/protocol";
import type { AgentazApi } from "./agentaz-api.ts";

/** HTTP wrapper for project-level pi-permission-system config APIs. */
export function createAgentazPermissions(api: AgentazApi) {
    function loadPermissionConfig() {
        return api.agentFetch<PermissionConfigResponse>(
            "/api/agent/permissions/config",
        );
    }

    function savePermissionConfig(config: PermissionSystemConfig) {
        return api.agentFetch<PermissionConfigResponse>(
            "/api/agent/permissions/config",
            {
                method: "PUT",
                body: { config } satisfies PermissionConfigSetRequest,
            },
        );
    }

    function resetPermissionConfig() {
        return api.agentFetch<PermissionConfigResponse>(
            "/api/agent/permissions/config/reset",
            { method: "POST" },
        );
    }

    return {
        loadPermissionConfig,
        savePermissionConfig,
        resetPermissionConfig,
    };
}

export type AgentazPermissions = ReturnType<typeof createAgentazPermissions>;
