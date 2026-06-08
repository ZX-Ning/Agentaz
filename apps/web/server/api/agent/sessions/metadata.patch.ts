import type { SessionRenameRequest } from "../../../../types/protocol";
import {
  agentHttpError,
  readJsonBody,
  requestClientId,
} from "../../../utils/agent-http";
import { getAgentRuntime } from "../../../utils/agent-runtime";
import { getAgentState } from "../../../utils/session-projector";

/**
 * PATCH /api/agent/sessions/metadata
 *
 * Renames a persisted Pi session in the configured working directory.
 * The session does not need to be loaded; unloaded sessions are opened only
 * long enough to append the Pi SDK's session_info metadata entry.
 *
 * Request body (JSON): SessionRenameRequest
 *   - sessionFile: Absolute path to an existing, non-deleted session file
 *     returned by the current cwd's persistedSessions list.
 *   - name: New display name. The trimmed value must be non-empty and at most
 *     120 characters.
 *
 * Headers:
 *   x-agentaz-client-id (optional): Browser tab identity for a client-specific
 *   AgentStateResponse projection.
 *
 * Response (200): SessionOperationResponse — extends AgentStateResponse
 *   Includes the full state snapshot plus the renamed sessionFile and, when
 *   the session is loaded, its sessionId.
 *
 * Side effects:
 *   - Appends a session_info metadata entry to the session JSONL file.
 *   - Refreshes the persisted session cache and emits state_changed.
 *
 * Errors:
 *   - 400: Missing sessionFile, missing name, or name longer than 120 chars
 *   - 404: sessionFile is not a normal persisted session for the current cwd
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(async (event) => {
  try {
    const body = await readJsonBody<SessionRenameRequest>(event);
    const runtime = getAgentRuntime();
    const clientId = requestClientId(event);

    const result = await runtime.workspace.renamePersistedSession(
      body.sessionFile ?? "",
      body.name ?? "",
    );
    const state = getAgentState(runtime.workspace, runtime.presence, clientId);

    return {
      ...state,
      ...result,
    };
  } catch (error) {
    throw agentHttpError(error);
  }
});
