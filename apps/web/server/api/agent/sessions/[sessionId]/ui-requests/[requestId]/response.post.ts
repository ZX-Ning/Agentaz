import type { UiRequestResponseRequest } from "../../../../../../../types/protocol";
import {
  agentHttpError,
  readJsonBody,
  requireRouteParam,
  withRequestSessionControl,
} from "../../../../../../utils/agent-http";
/**
 * POST /api/agent/sessions/:sessionId/ui-requests/:requestId/response
 *
 * Resolves a browser-backed extension UI prompt. When a Pi extension calls
 * uiContext.select(), .input(), or .confirm(), the backend emits a WebSocket
 * event and waits for the browser to POST a response. This endpoint provides
 * that response.
 *
 * Route params:
 *   - sessionId: The target loaded session identifier
 *   - requestId: The opaque request identifier from the WebSocket event
 *
 * Request body (JSON): UiRequestResponseRequest — discriminated union:
 *   - { selected: string }   — response to a select prompt
 *   - { value: string }      — response to an input prompt
 *   - { confirmed: boolean } — response to a confirm prompt
 *
 * Response (200):
 *   - ok: true
 *   - sessionId: Echo of the route param
 *   - requestId: Echo of the requestId route param
 *
 * Lifecycle:
 *   1. The browser receives a ui_select_request/ui_input_request/ui_confirm_request
 *      WebSocket event (from the extension UI context).
 *   2. The user interacts with the prompt in the browser UI.
 *   3. The frontend POSTs the response to this endpoint.
 *   4. The backend resolves the pending promise, unblocking the extension code.
 *
 * Errors:
 *   - 400: Missing route params
 *   - 404: Session not loaded or requestId not found
 *   - 409: Session is controlled by another browser client
 *   - 500: Unexpected runtime error
 */
export default defineEventHandler(async (event) => {
  try {
    const sessionId = requireRouteParam(event, "sessionId");
    const requestId = requireRouteParam(event, "requestId");
    const body = await readJsonBody<UiRequestResponseRequest>(event);

    // Dispatch to correct resolver based on response shape.
    await withRequestSessionControl(event, sessionId, async (lease) =>
      lease.runtime.workspace.resolveUiRequest(
        sessionId,
        requestId,
        body as UiRequestResponseRequest,
      ),
    );
    return { ok: true, sessionId, requestId };
  } catch (error) {
    throw agentHttpError(error);
  }
});
