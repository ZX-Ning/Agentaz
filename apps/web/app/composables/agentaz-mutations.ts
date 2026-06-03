import type {
  PendingUiRequest,
  UiExtensionWidget,
  UiLoadedSession,
} from "../../types/protocol";
import type { AgentazContext } from "./agentaz-state";

/**
 * Local mutation helpers for the per-session UI bookkeeping kept on the
 * controller context: loaded-session patches, extension widgets, pending UI
 * requests, optimistic prompt-working flags, and completed-turn focus requests.
 *
 * These are pure state writes against the refs in `AgentazContext` — no I/O.
 */
export function createAgentazMutations(ctx: AgentazContext) {
  function upsertLoadedSession(
    sessionId: string,
    patch: Partial<UiLoadedSession>,
  ) {
    const index = ctx.loadedSessions.value.findIndex(
      (session) => session.sessionId === sessionId,
    );
    if (index === -1) {
      ctx.loadedSessions.value.push({
        file: patch.file ?? patch.sessionFile ?? sessionId,
        sessionId,
        sessionFile: patch.sessionFile,
        isWorking: patch.isWorking ?? false,
        isStreaming: patch.isStreaming ?? false,
        pendingMessageCount: patch.pendingMessageCount ?? 0,
        pendingApprovalCount: patch.pendingApprovalCount ?? 0,
        pendingUiRequests: patch.pendingUiRequests ?? [],
        extensionWidgets: patch.extensionWidgets ?? [],
        controlOwnerClientId: patch.controlOwnerClientId,
        controlledByCurrentClient: patch.controlledByCurrentClient,
      });
      return;
    }
    const current = ctx.loadedSessions.value[index];
    if (!current) return;
    ctx.loadedSessions.value[index] = {
      ...current,
      ...patch,
      file: patch.file ?? patch.sessionFile ?? current.file,
    };
  }

  function upsertExtensionWidget(
    sessionId: string,
    patch: {
      key: string;
      placement?: UiExtensionWidget["placement"];
      lines?: string[];
    },
  ) {
    if (
      !ctx.loadedSessions.value.some((item) => item.sessionId === sessionId)
    ) {
      upsertLoadedSession(sessionId, {});
    }
    const currentSession = ctx.loadedSessions.value.find(
      (item) => item.sessionId === sessionId,
    );
    if (!currentSession) return;

    const widgets = currentSession.extensionWidgets ?? [];
    const nextWidgets =
      patch.lines === undefined
        ? widgets.filter((widget) => widget.key !== patch.key)
        : [
            ...widgets.filter((widget) => widget.key !== patch.key),
            {
              key: patch.key,
              placement: patch.placement ?? "aboveEditor",
              lines: patch.lines,
            },
          ];
    upsertLoadedSession(sessionId, { extensionWidgets: nextWidgets });
  }

  function addPendingUiRequest(event: PendingUiRequest) {
    const requests =
      ctx.pendingUiRequestsBySessionId.value[event.sessionId] ?? [];
    const nextRequests = [
      ...requests.filter((item) => item.requestId !== event.requestId),
      event,
    ];
    ctx.pendingUiRequestsBySessionId.value[event.sessionId] = nextRequests;
    upsertLoadedSession(event.sessionId, {
      pendingApprovalCount: nextRequests.length,
    });
  }

  function syncPendingUiRequestsFromLoadedSessions(
    sessions: UiLoadedSession[],
  ) {
    const next = { ...ctx.pendingUiRequestsBySessionId.value };
    const loadedSessionIds = new Set<string>();

    for (const session of sessions) {
      loadedSessionIds.add(session.sessionId);
      next[session.sessionId] = session.pendingUiRequests ?? [];
    }

    for (const sessionId of Object.keys(next)) {
      if (!loadedSessionIds.has(sessionId)) delete next[sessionId];
    }

    ctx.pendingUiRequestsBySessionId.value = next;
  }

  function removePendingUiRequest(sessionId: string, requestId: string) {
    const nextRequests = (
      ctx.pendingUiRequestsBySessionId.value[sessionId] ?? []
    ).filter((item) => item.requestId !== requestId);
    ctx.pendingUiRequestsBySessionId.value[sessionId] = nextRequests;
    upsertLoadedSession(sessionId, {
      pendingApprovalCount: nextRequests.length,
    });
  }

  /**
   * Tracks prompt work that the browser initiated before the next server state
   * snapshot arrives.
   *
   * The message submit endpoint is fire-and-forget, so this local bit keeps the
   * transcript footer responsive during the short gap between HTTP acceptance
   * and the first SSE snapshot/status update for the agent turn.
   */
  function setLocalPromptWorking(sessionId: string, isWorking: boolean) {
    const next = { ...ctx.locallyPendingPromptBySessionId.value };
    if (isWorking) next[sessionId] = true;
    else delete next[sessionId];
    ctx.locallyPendingPromptBySessionId.value = next;
  }

  /**
   * Moves local prompt-working state when the first prompt turns a draft
   * frontend session into a real backend session.
   */
  function moveLocalPromptWorking(fromSessionId: string, toSessionId: string) {
    if (fromSessionId === toSessionId) return;
    const wasWorking = ctx.locallyPendingPromptBySessionId.value[fromSessionId];
    if (!wasWorking) return;

    const next = { ...ctx.locallyPendingPromptBySessionId.value };
    delete next[fromSessionId];
    next[toSessionId] = true;
    ctx.locallyPendingPromptBySessionId.value = next;
  }

  /**
   * Requests that the workspace move keyboard focus to the newest assistant
   * response once the completed turn has settled into the DOM.
   */
  function requestCompletedTurnFocus(sessionId: string) {
    ctx.completedTurnFocusRequest.value = {
      sessionId,
      nonce: ++ctx.nonces.completedTurnFocus,
    };
  }

  return {
    upsertLoadedSession,
    upsertExtensionWidget,
    addPendingUiRequest,
    syncPendingUiRequestsFromLoadedSessions,
    removePendingUiRequest,
    setLocalPromptWorking,
    moveLocalPromptWorking,
    requestCompletedTurnFocus,
  };
}

export type AgentazMutations = ReturnType<typeof createAgentazMutations>;
