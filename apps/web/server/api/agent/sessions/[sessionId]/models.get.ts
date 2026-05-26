import {
  agentHttpError,
  getConfiguredAgentRegistry,
  requireRouteParam,
} from "../../../../utils/agent-http";
/**
 * GET /api/agent/sessions/:sessionId/models
 *
 * Returns model and thinking state for a specific loaded session.
 * Unlike the global GET /api/agent/models endpoint, this includes
 * the session's currently selected model, thinking level, and any
 * pending (queued) model/thinking changes.
 *
 * Route params:
 *   - sessionId: The target loaded session identifier
 *
 * Response (200): ModelStateResponse
 *   - sessionId: Echo of the route param
 *   - models: All available models for the picker
 *   - current: The session's active model (or restored from disk if not yet initialized)
 *   - thinkingLevel: Current thinking level (or restored default)
 *   - availableThinkingLevels: Levels supported by the current model
 *   - pendingModel: Model change queued while session is busy
 *   - pendingThinkingLevel: Thinking level change queued while session is busy
 *
 * Errors:
 *   - 400: Missing sessionId route param
 *   - 404: Session not loaded
 *   - 500: Unexpected registry error
 */
export default defineEventHandler((event) => {
  try {
    return getConfiguredAgentRegistry().getSessionModelState(
      requireRouteParam(event, "sessionId"),
    );
  } catch (error) {
    throw agentHttpError(error);
  }
});
