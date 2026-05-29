import type { SessionEntriesResponse } from "../../../../../types/protocol";
import {
  agentHttpError,
  getConfiguredAgentRegistry,
  requireRouteParam,
} from "../../../../utils/agent-http";

/**
 * GET /api/agent/sessions/:sessionId/entries
 *
 * Returns selectable fork/revert entries for a loaded Pi session.
 * The response is a linear current-branch view: only message entries on the
 * active root-to-leaf path are returned, not the full Pi SDK session tree.
 *
 * Route params:
 *   - sessionId: The target loaded session identifier
 *
 * Request body: none
 *
 * Headers:
 *   - x-agentaz-client-id (optional): Accepted for consistency with other
 *     agent routes, but this read-only endpoint does not use client presence.
 *
 * Response (200): SessionEntriesResponse
 *   - sessionId: Echo of the route param
 *   - entries: Current-branch message entries with id, role, summary,
 *     timestamp, and branch-local index
 *
 * Side effects: none
 *
 * Errors:
 *   - 400: Missing sessionId route param
 *   - 404: Session not loaded
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler((event): SessionEntriesResponse => {
  try {
    return getConfiguredAgentRegistry().getSessionEntries(
      requireRouteParam(event, "sessionId"),
    );
  } catch (error) {
    throw agentHttpError(error);
  }
});
