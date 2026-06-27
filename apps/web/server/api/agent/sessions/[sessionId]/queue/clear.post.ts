import {
    agentHttpError,
    requireRouteParam,
    withRequestSessionControl,
} from "../../../../../utils/agent-http";
/**
 * POST /api/agent/sessions/:sessionId/queue/clear
 *
 * Clears all queued steer and follow-up messages for a loaded session.
 * This is useful when the user wants to discard pending redirects or
 * queued follow-ups before they are processed by the agent.
 *
 * Route params:
 *   - sessionId: The target loaded session identifier
 *
 * Response (200):
 *   - ok: true
 *   - sessionId: Echo of the route param
 *
 * Side effects:
 *   - All queued steering and follow-up messages are discarded.
 *   - A queue_update WebSocket event is emitted with empty arrays.
 *   - A session status event is sent to update the frontend.
 *
 * Errors:
 *   - 400: Missing sessionId route param
 *   - 404: Session not loaded
 *   - 409: Session is controlled by another browser client
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(async event => {
    try {
        const sessionId = requireRouteParam(event, "sessionId");

        // Acquire and release control within a try/finally wrapper.
        await withRequestSessionControl(event, sessionId, lease =>
            lease.runtime.workspace.clearSessionQueue(sessionId),
        );
        return { ok: true, sessionId };
    } catch (error) {
        throw agentHttpError(error);
    }
});
