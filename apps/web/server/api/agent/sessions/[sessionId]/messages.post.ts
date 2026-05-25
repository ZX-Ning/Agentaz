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

export default defineEventHandler(
  async (event): Promise<MessageSubmitResponse> => {
    try {
      const sessionId = requireRouteParam(event, "sessionId");
      const body = await readJsonBody<MessageSubmitRequest>(event);
      if (!body.text || !body.mode)
        throw new Error("Message mode and text are required.");
      const lease = acquireRequestSessionControl(event, sessionId);
      try {
        lease.runtime.workspace.submitMessage(
          sessionId,
          {
            mode: body.mode,
            text: body.text,
            images: body.images,
          },
          lease.release,
        );
      } catch (error) {
        lease.release();
        throw error;
      }
      return { accepted: true, sessionId };
    } catch (error) {
      throw agentHttpError(error);
    }
  },
);
