import type { ServerEvent, ServerHello } from "../../types/protocol";
import { apiBase, isDraftSessionId } from "../utils/app.util";
import {
  appendMessageBlockDelta,
  confirmOptimisticUserMessage,
  removeUserMessageByClientMessageId,
  upsertMessage,
  upsertMessageBlock,
} from "../utils/agentaz-transcript";
import type { AgentazContext } from "./agentaz-state";
import type { AgentazApi } from "./agentaz-api";
import type { AgentazMutations } from "./agentaz-mutations";

/**
 * SSE wiring: the `handleEvent` dispatcher that folds every server event into
 * local state, and `connectEventSource` which opens `/api/agent/events` and
 * resolves once the initial `hello` arrives.
 *
 * Reads from the API layer (`applyState`, `resolveActiveSessionFromState`),
 * the mutation helpers, and the session refresh routines.
 */
export function createAgentazEvents(
  ctx: AgentazContext,
  api: AgentazApi,
  mutations: AgentazMutations,
  deps: {
    refreshSessionDetails: (sessionId: string) => Promise<void>;
    refreshHistory: (sessionId: string, force?: boolean) => Promise<void>;
    refreshModelState: (sessionId: string) => Promise<void>;
    syncBrowserRouteToSession: (
      sessionId?: string | null,
      mode?: "push" | "replace",
    ) => Promise<void>;
  },
) {
  const toast = useToast();
  const { applyState, resolveActiveSessionFromState } = api;
  const {
    upsertLoadedSession,
    upsertExtensionWidget,
    addPendingUiRequest,
    syncPendingUiRequestsFromLoadedSessions,
    setLocalPromptWorking,
    requestCompletedTurnFocus,
  } = mutations;
  const {
    refreshSessionDetails,
    refreshHistory,
    refreshModelState,
    syncBrowserRouteToSession,
  } = deps;

  function handleEvent(event: ServerEvent) {
    if (event.type === "hello") {
      ctx.hello.value = event;
      ctx.clientId.value = event.clientId;
      applyState(event.state);
      return;
    }

    if (event.type === "state_snapshot") {
      const previousActiveSessionId = ctx.activeSessionId.value;
      const state = event.state;
      ctx.activeSessionId.value = resolveActiveSessionFromState(state, true);
      ctx.loadedSessions.value = state.loadedSessions;
      syncPendingUiRequestsFromLoadedSessions(state.loadedSessions);
      if (state.persistedSessions.length > 0)
        ctx.persistedSessions.value = state.persistedSessions;
      if (
        ctx.activeSessionId.value &&
        !isDraftSessionId(ctx.activeSessionId.value) &&
        ctx.activeSessionId.value !== previousActiveSessionId
      ) {
        void refreshSessionDetails(ctx.activeSessionId.value);
      }
      if (
        ctx.hasAppliedInitialRoute.value &&
        ctx.activeSessionId.value &&
        !isDraftSessionId(ctx.activeSessionId.value)
      ) {
        void syncBrowserRouteToSession(ctx.activeSessionId.value, "replace");
      }
      return;
    }

    if (event.type === "control_changed") {
      upsertLoadedSession(event.sessionId, {
        controlOwnerClientId: event.controlOwnerClientId,
        controlledByCurrentClient:
          event.controlOwnerClientId === ctx.clientId.value,
      });
      return;
    }

    if (event.type === "turn_started") {
      confirmOptimisticUserMessage(
        ctx.messagesBySessionId.value,
        event.sessionId,
        event.clientMessageId,
        event.userMessage,
      );
      return;
    }

    if (event.type === "turn_completed") {
      setLocalPromptWorking(event.sessionId, false);
      void (async () => {
        const knownRevision =
          ctx.transcriptRevisionBySessionId.value[event.sessionId] ?? -1;
        if (event.transcriptRevision > knownRevision) {
          await refreshHistory(event.sessionId, true);
        }
        requestCompletedTurnFocus(event.sessionId);
      })();
      return;
    }

    if (event.type === "turn_failed") {
      setLocalPromptWorking(event.sessionId, false);
      if (event.clientMessageId) {
        removeUserMessageByClientMessageId(
          ctx.messagesBySessionId.value,
          event.sessionId,
          event.clientMessageId,
        );
      }
      if (event.transcriptRevision !== undefined) {
        ctx.transcriptRevisionBySessionId.value[event.sessionId] = Math.max(
          ctx.transcriptRevisionBySessionId.value[event.sessionId] ?? -1,
          event.transcriptRevision,
        );
      }
      void refreshHistory(event.sessionId, true);
      return;
    }

    if (event.type === "message_upsert") {
      upsertMessage(
        ctx.messagesBySessionId.value,
        event.sessionId,
        event.message,
      );
      return;
    }

    if (event.type === "message_block_upsert") {
      upsertMessageBlock(
        ctx.messagesBySessionId.value,
        event.sessionId,
        event.messageId,
        event.block,
      );
      return;
    }

    if (event.type === "message_block_delta") {
      appendMessageBlockDelta(
        ctx.messagesBySessionId.value,
        event.sessionId,
        event.messageId,
        event.blockId,
        event.blockType,
        event.delta,
      );
      return;
    }

    if (event.type === "status") {
      if (event.sessionId) {
        const mState = ctx.ensureModelState(event.sessionId);
        const shouldRefreshModelState =
          !event.isStreaming &&
          (mState.pendingModelChange || mState.pendingThinkingChange);
        const isWorking =
          event.isStreaming ||
          event.pendingMessageCount > 0 ||
          (event.pendingApprovalCount ?? 0) > 0;
        upsertLoadedSession(event.sessionId, {
          isWorking,
          isStreaming: event.isStreaming,
          pendingMessageCount: event.pendingMessageCount,
          pendingApprovalCount: event.pendingApprovalCount ?? 0,
        });
        if ((event.pendingApprovalCount ?? 0) === 0) {
          ctx.pendingUiRequestsBySessionId.value[event.sessionId] = [];
        }
        if (shouldRefreshModelState) void refreshModelState(event.sessionId);
      }
      return;
    }

    if (
      event.type === "ui_select_request" ||
      event.type === "ui_input_request" ||
      event.type === "ui_confirm_request"
    ) {
      addPendingUiRequest(event);
      toast.add({
        title: "Approval requested",
        description: event.title,
        color: "warning",
      });
      return;
    }

    if (event.type === "error") {
      ctx.lastError.value = event.message;
      toast.add({
        title: event.code,
        description: event.message,
        color: "error",
      });
      return;
    }

    if (event.type === "ui_notify") {
      toast.add({
        title: event.message,
        color:
          event.level === "error"
            ? "error"
            : event.level === "warning"
              ? "warning"
              : "info",
      });
      return;
    }

    if (event.type === "extension_widget_update") {
      upsertExtensionWidget(event.sessionId, event);
    }
  }

  function connectEventSource() {
    const es = new EventSource(`${apiBase()}/api/agent/events`);
    ctx.eventSource.value = es;

    return new Promise<ServerHello>((resolve, reject) => {
      es.addEventListener("open", () => {
        ctx.status.value = "connected";
        ctx.hasShownDisconnectToast.value = false;
      });

      es.addEventListener("message", (message) => {
        try {
          const event = JSON.parse(message.data) as ServerEvent;
          handleEvent(event);
          if (event.type === "hello") resolve(event);
        } catch (error) {
          ctx.lastError.value =
            error instanceof Error ? error.message : String(error);
          reject(error);
        }
      });

      es.addEventListener("error", () => {
        const hadInitialConnection = Boolean(ctx.hello.value);
        if (!hadInitialConnection) {
          // Connection never succeeded — treat as failure.
          ctx.status.value = "error";
          ctx.lastError.value = "SSE connection failed.";
          reject(new Error("SSE connection failed before hello."));
          return;
        }
        // Already had a successful connection — EventSource will auto-reconnect.
        ctx.status.value = "disconnected";
        if (!ctx.isUnmounting.value && !ctx.hasShownDisconnectToast.value) {
          ctx.hasShownDisconnectToast.value = true;
          toast.add({
            title: "Connection lost",
            description:
              "The realtime agent connection was lost. Attempting to reconnect...",
            color: "warning",
            duration: 15_000,
          });
        }
      });
    });
  }

  return { handleEvent, connectEventSource };
}

export type AgentazEvents = ReturnType<typeof createAgentazEvents>;
