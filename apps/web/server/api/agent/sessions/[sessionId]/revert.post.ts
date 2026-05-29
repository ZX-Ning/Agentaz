import type {
  SessionOperationResponse,
  SessionRevertRequest,
} from "../../../../../types/protocol";
import {
  agentHttpError,
  readJsonBody,
  requestClientId,
  requireRouteParam,
  withRequestSessionControl,
} from "../../../../utils/agent-http";
import { getAgentRuntime } from "../../../../utils/agent-runtime";
import { BadRequestError } from "../../../../utils/domain-errors";

/**
 * POST /api/agent/sessions/:sessionId/revert
 *
 * Reverts a loaded, persisted, idle Pi session in place to a current-branch
 * message entry. The session JSONL remains append-only: the backend moves the
 * Pi SDK leaf pointer to entryId and appends a session_info entry so reopening
 * the same file restores the reverted branch.
 *
 * Route params:
 *   - sessionId: The loaded session identifier to revert
 *
 * Request body (JSON): SessionRevertRequest
 *   - entryId: Current-branch message entry id that becomes the restored leaf
 *
 * Headers:
 *   - x-agentaz-client-id (optional): Browser tab identity for session
 *     control and client-specific state projection
 *
 * Response (200): SessionOperationResponse
 *   Full state snapshot plus the reverted sessionId and sessionFile.
 *
 * Side effects:
 *   - Acquires and releases a request-scoped control lease on the session.
 *   - Appends a session_info entry to persist the new leaf position.
 *   - Disposes and reloads the session controller from the same JSONL file.
 *   - Keeps the requesting browser client focused on the reverted session.
 *   - Refreshes persisted session metadata and emits state_changed.
 *
 * Errors:
 *   - 400: Missing entryId or malformed JSON request body
 *   - 400: Missing sessionId route param
 *   - 404: Session not loaded
 *   - 404: entryId is not selectable in the current branch
 *   - 409: Session is busy
 *   - 409: Session is not persisted
 *   - 409: Session is controlled by another browser client
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(
  async (event): Promise<SessionOperationResponse> => {
    try {
      const sessionId = requireRouteParam(event, "sessionId");
      const body = await readJsonBody<SessionRevertRequest>(event);
      const clientId = requestClientId(event);

      if (!body.entryId) {
        throw new BadRequestError("Session entry id is required.");
      }

      const controller = await withRequestSessionControl(
        event,
        sessionId,
        (lease) =>
          lease.runtime.workspace.revertSession(sessionId, body.entryId!),
      );

      const runtime = getAgentRuntime();
      runtime.presence.focus(clientId, controller.sessionId);
      runtime.eventBus.publish({ type: "state_changed" });

      return {
        ...runtime.projector.getState(clientId),
        sessionId: controller.sessionId,
        sessionFile: controller.sessionFile,
      };
    } catch (error) {
      throw agentHttpError(error);
    }
  },
);
