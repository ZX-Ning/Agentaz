import {
  agentHttpError,
  requestClientId,
  requireRouteParam,
} from "../../../../utils/agent-http";
import { getAgentRuntime } from "../../../../utils/agent-runtime";
import { SessionNotFoundError } from "../../../../utils/domain-errors";
import { getAgentState } from "../../../../utils/session-projector";
/**
 * POST /api/agent/sessions/:sessionId/focus
 *
 * Switches the requesting browser client's active session to the given
 * sessionId. This is a client-local operation — it does not affect other
 * connected browser clients. The response includes the full state snapshot
 * so the frontend can update in a single round-trip.
 *
 * Route params:
 *   - sessionId: The loaded session to focus for this client
 *
 * Headers:
 *   x-agentaz-client-id (optional): Browser tab identity for presence tracking.
 *
 * Response (200): SessionOperationResponse
 *   Full state snapshot plus the focused sessionId.
 *
 * Side effects:
 *   - Sets the client's last-active session for reconnection defaults.
 *   - Publishes a state_changed event to trigger SSE snapshot refresh.
 *
 * Errors:
 *   - 400: Missing sessionId route param
 *   - 404: Session not loaded
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(async (event) => {
  try {
    const runtime = getAgentRuntime();
    const sessionId = requireRouteParam(event, "sessionId");

    // Validate the session exists before mutating presence state.
    if (!runtime.workspace.hasSession(sessionId)) {
      throw new SessionNotFoundError();
    }

    const clientId = requestClientId(event);
    runtime.presence.focus(clientId, sessionId);
    runtime.eventBus.publish({ type: "state_changed" });

    // Return the updated state snapshot for this client.
    return {
      ...getAgentState(runtime.workspace, runtime.presence, clientId),
      sessionId,
    };
  } catch (error) {
    throw agentHttpError(error);
  }
});
