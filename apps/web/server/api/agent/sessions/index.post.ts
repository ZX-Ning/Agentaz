import type { SessionCreateRequest } from "../../../../types/protocol";
import {
  agentHttpError,
  requestClientId,
  readJsonBody,
} from "../../../utils/agent-http";
import { getAgentRuntime } from "../../../utils/agent-runtime";
/**
 * POST /api/agent/sessions
 *
 * Creates a new Pi session or opens an existing persisted session.
 * The newly created/opened session is automatically focused for the
 * requesting browser client. If no sessionFile is provided, a fresh
 * persisted session is created in the configured working directory.
 *
 * Request body (JSON): SessionCreateRequest
 *   - sessionFile (optional): Absolute path to an existing session file.
 *     When omitted, a new session is created via the Pi SDK SessionManager.
 *
 * Headers:
 *   x-agentaz-client-id (optional): Browser tab identity for presence tracking.
 *
 * Response (200): SessionOperationResponse — extends AgentStateResponse
 *   Includes the full state snapshot plus the new sessionId and sessionFile.
 *
 * Side effects:
 *   - A Pi session is loaded into the process working set.
 *   - The requesting client is focused on this session.
 *   - If the working set is at capacity, an idle session may be evicted first.
 *
 * Errors:
 *   - 400: Invalid request body
 *   - 409: Loaded session limit reached and no idle session can be evicted
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(async (event) => {
  try {
    const body = await readJsonBody<SessionCreateRequest>(event);
    const runtime = getAgentRuntime();
    const clientId = requestClientId(event);

    // Open an existing session file or create a brand-new session.
    const controller = body.sessionFile
      ? await runtime.workspace.openLoadedSession(body.sessionFile)
      : await runtime.workspace.createLoadedSession();

    // Automatically focus the requesting client on the new session.
    runtime.presence.focus(clientId, controller.sessionId);

    // Return the full state snapshot augmented with the new session identity.
    const state = runtime.projector.getState(clientId);
    return {
      ...state,
      sessionId: controller.sessionId,
      sessionFile: controller.sessionFile,
    };
  } catch (error) {
    throw agentHttpError(error);
  }
});
