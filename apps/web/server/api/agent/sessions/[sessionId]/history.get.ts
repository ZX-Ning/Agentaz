import {
  agentHttpError,
  getConfiguredAgentRegistry,
  requireRouteParam,
} from "../../../../utils/agent-http";
/**
 * GET /api/agent/sessions/:sessionId/history
 *
 * Returns the normalized chat transcript for a loaded Pi session.
 * Messages are converted from Pi SDK internal representations into
 * the browser-compatible UiMessage/UiBlock format. The result is
 * cached until the transcript changes.
 *
 * Route params:
 *   - sessionId: The target loaded session identifier
 *
 * Response (200): SessionHistoryResponse
 *   - sessionId: Echo of the route param
 *   - messages: Array of normalized UiMessage objects, each containing
 *     blocks (text, thinking, tool_call, tool_result) with stable ids and,
 *     for persisted current-branch messages, entryId and rewindEntryId anchors
 *
 * Errors:
 *   - 400: Missing sessionId route param
 *   - 404: Session not loaded
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler((event) => {
  try {
    return getConfiguredAgentRegistry().getSessionHistory(
      requireRouteParam(event, "sessionId"),
    );
  } catch (error) {
    throw agentHttpError(error);
  }
});
