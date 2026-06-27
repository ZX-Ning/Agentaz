import {
    agentHttpError,
    getConfiguredAgentRegistry,
} from "../../utils/agent-http";
/**
 * GET /api/agent/models
 *
 * Returns the default model state without requiring a loaded session.
 * Used by the frontend to populate the model picker before any session
 * is created. The response includes the list of available models from the
 * Pi SDK model registry and the default thinking levels.
 *
 * Response (200): ModelStateResponse
 *   - sessionId: Always empty string (no session context)
 *   - models: All available models from the model registry
 *   - thinkingLevel: Default "off"
 *   - availableThinkingLevels: Full list of supported thinking levels
 *
 * Errors:
 *   - 500: Unexpected registry error
 */
export default defineEventHandler(() => {
    try {
        return getConfiguredAgentRegistry().getDefaultModelState();
    } catch (error) {
        throw agentHttpError(error);
    }
});
