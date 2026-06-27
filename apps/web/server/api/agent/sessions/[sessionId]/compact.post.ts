import type {
    ContextCompactRequest,
    ContextCompactResponse,
} from "../../../../../types/protocol";
import {
    agentHttpError,
    readJsonBody,
    requireRouteParam,
    withRequestSessionControl,
} from "../../../../utils/agent-http";
import { BadRequestError } from "../../../../utils/domain-errors";

/**
 * POST /api/agent/sessions/:sessionId/compact
 *
 * Manually compacts an idle loaded Pi session's active context. The endpoint is
 * synchronous: it returns after the Pi SDK has written the compaction entry.
 *
 * Route params:
 *   - sessionId: The target loaded session identifier
 *
 * Request body (JSON): ContextCompactRequest
 *   - customInstructions (optional): Extra focus for the compaction summary
 *
 * Response (200): ContextCompactResponse
 *   - ok: true
 *   - sessionId: Echo of the route param
 *   - summary, firstKeptEntryId, tokensBefore, details: Pi compaction result
 *   - revision: Normalized history revision after compaction
 *
 * Errors:
 *   - 400: Invalid request body
 *   - 404: Session not loaded
 *   - 409: Session is busy or controlled by another browser client
 *   - 409: Context is too small or already compacted
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(
    async (event): Promise<ContextCompactResponse> => {
        try {
            const sessionId = requireRouteParam(event, "sessionId");
            const body = await readJsonBody<ContextCompactRequest>(event);

            if (
                body.customInstructions !== undefined &&
                typeof body.customInstructions !== "string"
            ) {
                throw new BadRequestError(
                    "customInstructions must be a string when provided.",
                );
            }

            const customInstructions =
                body.customInstructions?.trim() || undefined;
            return await withRequestSessionControl(event, sessionId, lease =>
                lease.runtime.workspace.compactSession(sessionId, {
                    customInstructions,
                }),
            );
        } catch (error) {
            throw agentHttpError(error);
        }
    },
);
