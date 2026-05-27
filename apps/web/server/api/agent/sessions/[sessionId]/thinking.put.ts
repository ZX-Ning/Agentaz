import type { ThinkingSetRequest } from "../../../../../types/protocol";
import {
  agentHttpError,
  readJsonBody,
  requireRouteParam,
  withRequestSessionControl,
} from "../../../../utils/agent-http";
import { BadRequestError } from "../../../../utils/domain-errors";
/**
 * PUT /api/agent/sessions/:sessionId/thinking
 *
 * Sets the thinking level (off/minimal/low/medium/high/xhigh) for a
 * loaded session. Like model changes, if the session is busy the thinking
 * level change is queued until the agent becomes idle.
 *
 * Route params:
 *   - sessionId: The target loaded session identifier
 *
 * Request body (JSON): ThinkingSetRequest
 *   - level: One of "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
 *
 * Response (200): ModelStateResponse
 *   Same shape as GET /api/agent/sessions/:sessionId/models — includes
 *   the updated (or pending) thinking level.
 *
 * Errors:
 *   - 400: Missing thinking level
 *   - 404: Session not loaded
 *   - 409: Session is controlled by another browser client
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, "sessionId");
    const body = await readJsonBody<ThinkingSetRequest>(event);
    if (!body.level) throw new BadRequestError("Thinking level is required.");
    return await withRequestSessionControl(event, sessionId, (lease) =>
      lease.runtime.workspace.setSessionThinkingLevel(sessionId, body.level!),
    );
  } catch (error) {
    throw agentHttpError(error);
  }
});
