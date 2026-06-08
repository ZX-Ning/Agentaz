import { agentHttpError, requestClientId } from "../../utils/agent-http";
import { getAgentRuntime } from "../../utils/agent-runtime";
import {
  getAgentState,
  refreshProjectionData,
} from "../../utils/session-projector";

/**
 * GET /api/agent/state
 *
 * Returns the full backend state snapshot for the requesting browser client.
 * The response includes all loaded sessions, persisted session summaries,
 * the active session for this client, the working directory, and declared
 * capabilities. This is the primary synchronization endpoint — the frontend
 * calls it on page load and after any HTTP mutation to stay in sync.
 *
 * Headers:
 *   x-agentaz-client-id (optional): Browser tab identity for presence tracking.
 *     Falls back to the local-browser default if not provided.
 *
 * Response (200): AgentStateResponse
 *   - protocolVersion: Current wire protocol version (6)
 *   - cwd: Working directory shared by all sessions
 *   - activeSessionId: The session this client currently has focused
 *   - loadedSessions: All process-resident Pi sessions with runtime status
 *   - persistedSessions: All saved sessions in the working directory
 *   - capabilities: Feature flags (steer, followUp, modelSelect, etc.)
 *
 * Errors:
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(async (event) => {
  try {
    const runtime = getAgentRuntime();
    // Refresh persisted session cache so the snapshot includes any
    // sessions saved on disk since the last state refresh.
    await refreshProjectionData(runtime.workspace);
    return getAgentState(
      runtime.workspace,
      runtime.presence,
      requestClientId(event),
    );
  } catch (error) {
    throw agentHttpError(error);
  }
});
