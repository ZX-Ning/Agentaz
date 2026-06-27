import type { SessionDeleteRequest } from "../../../../types/protocol";
import {
    agentHttpError,
    readJsonBody,
    requestClientId,
} from "../../../utils/agent-http";
import { getAgentRuntime } from "../../../utils/agent-runtime";
import { getAgentState } from "../../../utils/session-projector";

/**
 * POST /api/agent/sessions/delete
 *
 * Soft-deletes a persisted Pi session in the configured working directory.
 * The JSONL content is preserved on disk by renaming the file from
 * *.jsonl to *.jsonl.deleted (or a timestamped variant if that target exists).
 *
 * Request body (JSON): SessionDeleteRequest
 *   - sessionFile: Absolute path to an existing, non-deleted session file
 *     returned by the current cwd's persistedSessions list.
 *
 * Headers:
 *   x-agentaz-client-id (optional): Browser tab identity for a client-specific
 *   AgentStateResponse projection.
 *
 * Response (200): SessionOperationResponse — extends AgentStateResponse
 *   Includes the full state snapshot plus the original sessionFile and, when
 *   the session was loaded, its sessionId.
 *
 * Side effects:
 *   - If the session is loaded and idle, disposes it and removes it from the
 *     process working set.
 *   - Renames the session file so the Pi SDK no longer lists it as active.
 *   - Publishes session_removed, refreshes persisted sessions, and emits
 *     state_changed.
 *
 * Errors:
 *   - 400: Missing sessionFile
 *   - 404: sessionFile is not a normal persisted session for the current cwd
 *   - 409: Loaded session is busy (streaming, queued, initializing, or waiting
 *     for browser UI approval)
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(async event => {
    try {
        const body = await readJsonBody<SessionDeleteRequest>(event);
        const runtime = getAgentRuntime();
        const clientId = requestClientId(event);

        const result = await runtime.workspace.softDeletePersistedSession(
            body.sessionFile ?? "",
        );
        const state = getAgentState(
            runtime.workspace,
            runtime.presence,
            clientId,
        );

        return {
            ...state,
            ...result,
        };
    } catch (error) {
        throw agentHttpError(error);
    }
});
