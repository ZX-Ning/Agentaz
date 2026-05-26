import {
  agentHttpError,
  requireRouteParam,
  withRequestSessionControl,
} from "../../../../utils/agent-http";
/**
 * POST /api/agent/sessions/:sessionId/abort
 *
 * Aborts the active agent operation and cancels all pending browser-backed
 * extension UI prompts for the given session. The caller must hold or acquire
 * session control.
 *
 * Route params:
 *   - sessionId: The target loaded session identifier
 *
 * Response (200):
 *   - ok: true
 *   - sessionId: Echo of the route param
 *
 * Side effects:
 *   - The active Pi agent workflow is interrupted.
 *   - All pending UI prompts (select, input, confirm) are resolved immediately.
 *   - A state_changed event is published to trigger frontend refresh.
 *
 * Errors:
 *   - 400: Missing sessionId route param
 *   - 404: Session not loaded
 *   - 409: Session is controlled by another browser client
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, "sessionId");

    // Acquire control, run the abort, and release control in a single
    // try/finally wrapper via withRequestSessionControl.
    await withRequestSessionControl(event, sessionId, (lease) =>
      lease.runtime.workspace.abortSession(sessionId),
    );
    return { ok: true, sessionId };
  } catch (error) {
    throw agentHttpError(error);
  }
});
