import type {
  SessionForkRequest,
  SessionOperationResponse,
} from "../../../../../types/protocol";
import {
  agentHttpError,
  readJsonBody,
  requestClientId,
  requireRouteParam,
  withRequestSessionControl,
} from "../../../../utils/agent-http";
import { getAgentRuntime } from "../../../../utils/agent-runtime";

/**
 * POST /api/agent/sessions/:sessionId/fork
 *
 * Forks a loaded, persisted, idle Pi session into a new loaded session. When
 * entryId is provided, the fork contains the current branch from root through
 * that entry. When entryId is omitted, the full source session file is copied.
 * The requesting browser client is focused on the newly loaded fork.
 *
 * Route params:
 *   - sessionId: The source loaded session identifier
 *
 * Request body (JSON): SessionForkRequest
 *   - entryId (optional): Current-branch message entry id to fork at
 *   - name (optional): Display name to append to the new fork
 *
 * Headers:
 *   - x-agentaz-client-id (optional): Browser tab identity for session
 *     control and client-specific state projection
 *
 * Response (200): SessionOperationResponse
 *   Full state snapshot plus the new fork's sessionId and sessionFile.
 *
 * Side effects:
 *   - Acquires and releases a request-scoped control lease on the source session.
 *   - Creates a new persisted Pi session JSONL file.
 *   - Loads the fork into the process working set, possibly evicting an idle
 *     non-active loaded session if the capacity limit is reached.
 *   - Focuses the requesting browser client on the fork.
 *   - Refreshes persisted session metadata and emits state_changed.
 *
 * Errors:
 *   - 400: Malformed JSON request body
 *   - 400: Missing sessionId route param
 *   - 404: Source session not loaded
 *   - 404: entryId is not selectable in the current branch
 *   - 409: Source session is busy
 *   - 409: Source session is not persisted
 *   - 409: Session is controlled by another browser client
 *   - 409: Loaded session limit reached and no idle session can be evicted
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(
  async (event): Promise<SessionOperationResponse> => {
    try {
      const sessionId = requireRouteParam(event, "sessionId");
      const body = await readJsonBody<SessionForkRequest>(event);
      const clientId = requestClientId(event);

      const controller = await withRequestSessionControl(
        event,
        sessionId,
        (lease) =>
          lease.runtime.workspace.forkSession(sessionId, {
            entryId: body.entryId,
            name: body.name,
          }),
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
