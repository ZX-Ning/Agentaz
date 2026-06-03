import type {
  AgentStateResponse,
  MessageSubmitRequest,
  ModelSetRequest,
  ModelStateResponse,
  SessionDeleteRequest,
  SessionForkRequest,
  SessionHistoryResponse,
  SessionOperationResponse,
  SessionRenameRequest,
  SessionRevertRequest,
} from "../../types/protocol";
import type { SessionListItem } from "../types/sessions";
import {
  defaultModelState,
  isDraftSessionId,
  createDraftSessionId,
  sessionUrl,
} from "../utils/app.util";
import {
  createClientMessageId,
  ensureMessageBucket,
  mergeHistoryWithOptimisticMessages,
} from "../utils/agentaz-transcript";
import type { AgentazContext } from "./agentaz-state";
import type { AgentazApi } from "./agentaz-api";
import type { AgentazMutations } from "./agentaz-mutations";

/**
 * Session lifecycle: history/model refreshes, draft creation and
 * materialisation, the session CRUD operations (create/open/focus/rename/
 * delete/fork/revert), and prompt submission.
 *
 * Depends on the API layer (fetch + state apply + switch intent), the mutation
 * helpers (optimistic prompt-working flags), and the low-level route sync
 * (`syncBrowserRouteToSession`) injected by the controller.
 */
export function createAgentazSessions(
  ctx: AgentazContext,
  api: AgentazApi,
  mutations: AgentazMutations,
  deps: {
    syncBrowserRouteToSession: (
      sessionId?: string | null,
      mode?: "push" | "replace",
    ) => Promise<void>;
  },
) {
  const { syncBrowserRouteToSession } = deps;
  const {
    agentFetch,
    applyState,
    applyModelState,
    beginSessionSwitchIntent,
    isCurrentSessionSwitchIntent,
    rememberSessionFocusIntent,
  } = api;
  const { setLocalPromptWorking, moveLocalPromptWorking } = mutations;

  async function refreshHistory(sessionId: string, force = false) {
    if (isDraftSessionId(sessionId)) return;
    if (!force && ctx.messagesBySessionId.value[sessionId]?.length) return;
    const history = await agentFetch<SessionHistoryResponse>(
      sessionUrl(sessionId, "/history"),
    );
    const knownRevision =
      ctx.transcriptRevisionBySessionId.value[sessionId] ?? -1;
    if (history.revision < knownRevision) return;
    ctx.transcriptRevisionBySessionId.value[sessionId] = history.revision;
    ctx.messagesBySessionId.value[sessionId] =
      mergeHistoryWithOptimisticMessages(
        ctx.messagesBySessionId.value[sessionId],
        history.messages,
      );
  }

  async function refreshModelState(sessionId: string) {
    if (isDraftSessionId(sessionId)) return;
    applyModelState(
      await agentFetch<ModelStateResponse>(sessionUrl(sessionId, "/models")),
    );
  }

  async function refreshSessionDetails(sessionId: string) {
    if (isDraftSessionId(sessionId)) return;
    await Promise.all([
      refreshHistory(sessionId),
      refreshModelState(sessionId),
    ]);
  }

  async function refreshDraftModelState(sessionId: string) {
    if (
      !isDraftSessionId(sessionId) ||
      ctx.modelStateBySessionId.value[sessionId]?.models.length
    )
      return;
    const state = await agentFetch<ModelStateResponse>("/api/agent/models");
    applyModelState({ ...state, sessionId });
  }

  async function refreshActiveStateDetails(state: AgentStateResponse) {
    if (state.activeSessionId) {
      await refreshSessionDetails(state.activeSessionId);
    } else {
      await refreshDraftModelState(ensureDraftSession());
    }
  }

  async function postSessionOperation(
    path: string,
    options?: Parameters<typeof $fetch<SessionOperationResponse>>[1],
    refreshHistoryForce = false,
    switchRequestNonce?: number,
  ) {
    const state = await agentFetch<SessionOperationResponse>(path, options);
    if (
      switchRequestNonce !== undefined &&
      !isCurrentSessionSwitchIntent(switchRequestNonce)
    ) {
      return state;
    }
    applyState(state);
    const detailSessionId = ctx.activeSessionId.value ?? state.activeSessionId;
    if (detailSessionId && !isDraftSessionId(detailSessionId))
      await Promise.all([
        refreshHistory(detailSessionId, refreshHistoryForce),
        refreshModelState(detailSessionId),
      ]);
    return state;
  }

  function createDraftSession() {
    const previousModelState = ctx.activeSessionId.value
      ? ctx.modelStateBySessionId.value[ctx.activeSessionId.value]
      : undefined;
    const sessionId = createDraftSessionId();
    beginSessionSwitchIntent(sessionId);
    ensureMessageBucket(ctx.messagesBySessionId.value, sessionId);
    ctx.modelStateBySessionId.value[sessionId] = previousModelState
      ? {
          models: previousModelState.models,
          currentModel: previousModelState.currentModel,
          thinkingLevel: previousModelState.thinkingLevel,
          availableThinkingLevels: [
            ...previousModelState.availableThinkingLevels,
          ],
          pendingModelChange: false,
          pendingThinkingChange: false,
        }
      : defaultModelState();
    return sessionId;
  }

  function ensureDraftSession() {
    if (!ctx.activeSessionId.value) return createDraftSession();
    return ctx.activeSessionId.value;
  }

  async function materializeDraftSession(draftSessionId: string) {
    const draftModelState = ctx.modelStateBySessionId.value[draftSessionId];
    const draftModel = draftModelState?.currentModel
      ? { ...draftModelState.currentModel }
      : null;
    const draftThinkingLevel = draftModelState?.thinkingLevel;
    const state = await agentFetch<SessionOperationResponse>(
      "/api/agent/sessions",
      { method: "POST" },
    );
    const sessionId = state.sessionId ?? state.activeSessionId;
    if (!sessionId)
      throw new Error("Backend did not return a created session id.");

    ctx.messagesBySessionId.value[sessionId] =
      ctx.messagesBySessionId.value[draftSessionId] ?? [];
    delete ctx.messagesBySessionId.value[draftSessionId];
    ctx.transcriptRevisionBySessionId.value[sessionId] =
      ctx.transcriptRevisionBySessionId.value[draftSessionId] ?? 0;
    delete ctx.transcriptRevisionBySessionId.value[draftSessionId];
    ctx.modelStateBySessionId.value[sessionId] =
      ctx.modelStateBySessionId.value[draftSessionId] ?? defaultModelState();
    delete ctx.modelStateBySessionId.value[draftSessionId];
    const switchNonce = beginSessionSwitchIntent(sessionId);
    applyState(state);
    rememberSessionFocusIntent(switchNonce, sessionId);
    ctx.activeSessionId.value = sessionId;
    await syncBrowserRouteToSession(sessionId, "replace");
    if (draftModel) {
      const body: ModelSetRequest = {
        provider: draftModel.provider,
        id: draftModel.id,
      };
      applyModelState(
        await agentFetch<ModelStateResponse>(sessionUrl(sessionId, "/model"), {
          method: "PUT",
          body,
        }),
      );
    }
    if (draftThinkingLevel) {
      applyModelState(
        await agentFetch<ModelStateResponse>(
          sessionUrl(sessionId, "/thinking"),
          { method: "PUT", body: { level: draftThinkingLevel } },
        ),
      );
    }
    return sessionId;
  }

  async function createSession() {
    await refreshDraftModelState(createDraftSession());
    await syncBrowserRouteToSession(ctx.activeSessionId.value, "push");
  }

  async function openPersistedSession(
    sessionFile: string,
    syncRoute = true,
    expectedSessionId?: string | null,
  ) {
    const switchNonce = beginSessionSwitchIntent(expectedSessionId);
    const state = await postSessionOperation(
      "/api/agent/sessions",
      {
        method: "POST",
        body: { sessionFile },
      },
      false,
      switchNonce,
    );
    if (!isCurrentSessionSwitchIntent(switchNonce)) return;
    const sessionId = state.sessionId ?? state.activeSessionId;
    rememberSessionFocusIntent(switchNonce, sessionId);
    if (syncRoute) {
      await syncBrowserRouteToSession(sessionId, "push");
    }
  }

  async function focusSession(sessionId: string, syncRoute = true) {
    const switchNonce = beginSessionSwitchIntent(sessionId);
    await postSessionOperation(
      sessionUrl(sessionId, "/focus"),
      {
        method: "POST",
      },
      false,
      switchNonce,
    );
    if (!isCurrentSessionSwitchIntent(switchNonce)) return;
    if (syncRoute) await syncBrowserRouteToSession(sessionId, "push");
  }

  async function renameSession(sessionFile: string, name: string) {
    const body: SessionRenameRequest = { sessionFile, name };
    await postSessionOperation("/api/agent/sessions/metadata", {
      method: "PATCH",
      body,
    });
  }

  async function deleteSession(session: SessionListItem) {
    if (!session.file) return;

    const deletedSessionId = session.sessionId;
    const body: SessionDeleteRequest = { sessionFile: session.file };
    await postSessionOperation("/api/agent/sessions/delete", {
      method: "POST",
      body,
    });

    if (deletedSessionId) {
      delete ctx.messagesBySessionId.value[deletedSessionId];
      delete ctx.transcriptRevisionBySessionId.value[deletedSessionId];
      delete ctx.modelStateBySessionId.value[deletedSessionId];
      delete ctx.pendingUiRequestsBySessionId.value[deletedSessionId];
    }

    await syncBrowserRouteToSession(ctx.activeSessionId.value, "replace");
  }

  async function forkFromMessage(rewindEntryId: string) {
    const sessionId = ctx.activeSessionId.value;
    if (!sessionId || isDraftSessionId(sessionId)) return;
    const body: SessionForkRequest = {
      entryId: rewindEntryId,
      name: `${ctx.activeSessionTitle.value} (fork)`,
    };
    const state = await postSessionOperation(
      sessionUrl(sessionId, "/fork"),
      {
        method: "POST",
        body,
      },
      true,
    );
    await syncBrowserRouteToSession(
      state.sessionId ?? state.activeSessionId,
      "push",
    );
  }

  async function revertToMessage(rewindEntryId: string) {
    const sessionId = ctx.activeSessionId.value;
    if (!sessionId || isDraftSessionId(sessionId)) return;
    const body: SessionRevertRequest = { entryId: rewindEntryId };
    const state = await postSessionOperation(
      sessionUrl(sessionId, "/revert"),
      {
        method: "POST",
        body,
      },
      true,
    );
    await syncBrowserRouteToSession(
      state.activeSessionId ?? sessionId,
      "replace",
    );
  }

  async function sendPrompt() {
    let sessionId = ctx.activeSessionId.value;
    const text = ctx.promptText.value.trim();
    if (!sessionId || !text) return;
    const startingSessionId = sessionId;

    const clientMessageId = createClientMessageId();
    const localMessageId = `local-${clientMessageId}`;
    ensureMessageBucket(ctx.messagesBySessionId.value, sessionId).push({
      id: localMessageId,
      clientMessageId,
      role: "user",
      blocks: [{ id: `${localMessageId}:text`, type: "text", text }],
      createdAt: Date.now(),
    });
    setLocalPromptWorking(sessionId, true);

    try {
      if (isDraftSessionId(sessionId)) {
        sessionId = await materializeDraftSession(sessionId);
        moveLocalPromptWorking(startingSessionId, sessionId);
      }

      const body: MessageSubmitRequest = {
        mode: "prompt",
        clientMessageId,
        text,
      };
      await agentFetch(sessionUrl(sessionId, "/messages"), {
        method: "POST",
        body,
      });
      ctx.promptText.value = "";
    } catch (error) {
      setLocalPromptWorking(startingSessionId, false);
      if (sessionId !== startingSessionId)
        setLocalPromptWorking(sessionId, false);
      throw error;
    }
  }

  async function submitComposer() {
    const sessionId = ctx.activeSessionId.value;
    if (!sessionId) return;
    if (!isDraftSessionId(sessionId) && ctx.isStreaming.value) {
      await agentFetch(sessionUrl(sessionId, "/abort"), { method: "POST" });
      return;
    }
    await sendPrompt();
  }

  return {
    refreshHistory,
    refreshModelState,
    refreshSessionDetails,
    refreshDraftModelState,
    refreshActiveStateDetails,
    postSessionOperation,
    createDraftSession,
    ensureDraftSession,
    materializeDraftSession,
    createSession,
    openPersistedSession,
    focusSession,
    renameSession,
    deleteSession,
    forkFromMessage,
    revertToMessage,
    sendPrompt,
    submitComposer,
  };
}

export type AgentazSessions = ReturnType<typeof createAgentazSessions>;
