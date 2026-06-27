import type {
    MessageSubmitRequest,
    MessageSubmitResponse,
} from "../../../../../types/protocol";
import {
    acquireRequestSessionControl,
    agentHttpError,
    readJsonBody,
    requireRouteParam,
} from "../../../../utils/agent-http";
import { BadRequestError } from "../../../../utils/domain-errors";
/**
 * POST /api/agent/sessions/:sessionId/messages
 *
 * Submits a prompt, steer, or follow-up message to a loaded Pi session.
 * Message processing is asynchronous — this endpoint accepts the message
 * and returns immediately while the Pi agent loop continues in the background.
 *
 * The caller must hold session control (acquired via x-agentaz-client-id header).
 * If another client currently controls this session, the request is rejected.
 *
 * Route params:
 *   - sessionId: The target loaded session identifier
 *
 * Request body (JSON): MessageSubmitRequest
 *   - mode: "prompt" for a new agent turn, "steer" to redirect streaming output,
 *     "follow_up" to queue a message after the current turn completes.
 *   - text: The message text to send to the Pi agent.
 *   - clientMessageId: Browser-generated id required for prompt submissions
 *     so SSE can confirm optimistic user messages. Follow-up messages mutate
 *     Pi's queue and do not currently create optimistic transcript messages.
 *   - images (optional): Base64-encoded image attachments (reserved for future use).
 *
 * Response (200): MessageSubmitResponse
 *   - accepted: Always true
 *   - sessionId: Echo of the route param
 *   - clientMessageId: Echo for prompt submissions
 *   - turnId: Server-side turn id for prompt submissions
 *
 * Lifecycle:
 *   1. Validate required fields (text, mode)
 *   2. Acquire a request-scoped session control lease
 *   3. Submit the message to the workspace (async fire-and-forget)
 *   4. The control lease is released when the message task settles
 *
 * Errors:
 *   - 400: Missing message mode or text
 *   - 404: Session not loaded
 *   - 409: Session is controlled by another browser client
 *   - 409: Agent is already running (steer/follow-up timing)
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(
    async (event): Promise<MessageSubmitResponse> => {
        try {
            const sessionId = requireRouteParam(event, "sessionId");
            const body = await readJsonBody<MessageSubmitRequest>(event);

            // Validate required message fields before acquiring control.
            if (!body.text || !body.mode)
                throw new BadRequestError(
                    "Message mode and text are required.",
                );
            if (
                body.mode !== "prompt" &&
                body.mode !== "steer" &&
                body.mode !== "follow_up"
            ) {
                throw new BadRequestError("Unsupported message mode.");
            }
            const clientMessageId =
                "clientMessageId" in body ? body.clientMessageId : undefined;
            if (body.mode === "prompt" && !clientMessageId) {
                throw new BadRequestError(
                    "clientMessageId is required for prompt messages.",
                );
            }

            // Acquire request-scoped control — blocks other clients from mutating
            // this session while we submit the message.
            const lease = acquireRequestSessionControl(event, sessionId);
            try {
                if (body.mode === "steer") {
                    return lease.runtime.workspace.submitMessage(
                        sessionId,
                        { mode: "steer", text: body.text, images: body.images },
                        // Release control when the message task settles (completes or errors).
                        lease.release,
                    );
                }
                if (body.mode === "follow_up") {
                    return lease.runtime.workspace.submitMessage(
                        sessionId,
                        {
                            mode: "follow_up",
                            text: body.text,
                            images: body.images,
                        },
                        // Release control when the message task settles (completes or errors).
                        lease.release,
                    );
                }
                return lease.runtime.workspace.submitMessage(
                    sessionId,
                    {
                        mode: "prompt",
                        clientMessageId: clientMessageId!,
                        text: body.text,
                        images: body.images,
                    },
                    // Release control when the message task settles (completes or errors).
                    lease.release,
                );
            } catch (error) {
                // If submission itself fails, release control immediately.
                lease.release();
                throw error;
            }
        } catch (error) {
            throw agentHttpError(error);
        }
    },
);
