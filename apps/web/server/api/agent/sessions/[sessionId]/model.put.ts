import type { ModelSetRequest } from "../../../../../types/protocol";
import {
  agentHttpError,
  readJsonBody,
  requireRouteParam,
  withRequestSessionControl,
} from "../../../../utils/agent-http";
/**
 * PUT /api/agent/sessions/:sessionId/model
 *
 * Sets the AI model for a loaded session. If the session is currently busy
 * (agent is streaming or has pending messages), the model change is queued
 * and applied when the session becomes idle. Otherwise the change takes
 * effect immediately.
 *
 * Route params:
 *   - sessionId: The target loaded session identifier
 *
 * Request body (JSON): ModelSetRequest
 *   - provider: Model provider identifier (e.g. "anthropic")
 *   - id: Model identifier within the provider (e.g. "claude-sonnet-4-20250514")
 *
 * Response (200): ModelStateResponse
 *   - sessionId: Echo of the route param
 *   - models: All available models for the picker
 *   - current: The now-active (or pending) model
 *   - thinkingLevel: Current thinking level
 *   - availableThinkingLevels: Levels supported by the current model
 *   - pendingModel: The queued model change (if session is busy)
 *   - pendingThinkingLevel: The queued thinking level change (if any)
 *
 * Errors:
 *   - 400: Missing provider or id
 *   - 400: Unknown model provider/id combination
 *   - 404: Session not loaded
 *   - 409: Session is controlled by another browser client
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, "sessionId");
    const body = await readJsonBody<ModelSetRequest>(event);

    if (!body.provider || !body.id)
      throw new Error("Model provider and id are required.");

    return await withRequestSessionControl(event, sessionId, (lease) =>
      lease.runtime.workspace.setSessionModel(
        sessionId,
        body.provider!,
        body.id!,
      ),
    );
  } catch (error) {
    throw agentHttpError(error);
  }
});
