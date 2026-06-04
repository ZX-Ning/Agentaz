import type {
  AgentStateResponse,
  ModelStateResponse,
  SessionOperationResponse,
  ThinkingLevel,
  UiLoadedSession,
} from "../../types/protocol";
import {
  apiBase,
  isDraftSessionId,
  closestThinkingLevel,
} from "../utils/app.util";
import type { AgentazContext } from "./agentaz-state";

/**
 * HTTP/state-application layer for the Agentaz controller.
 *
 * Owns the authenticated `agentFetch` wrapper, the routines that fold backend
 * state snapshots into the local refs (`applyState`, `applyModelState`,
 * `updateThinkingState`), and the session-switch intent bookkeeping that lets
 * out-of-order network responses be reconciled against the latest user choice.
 */
export function createAgentazApi(
  ctx: AgentazContext,
  deps: {
    syncPendingUiRequestsFromLoadedSessions: (
      sessions: UiLoadedSession[],
    ) => void;
  },
) {
  const toast = useToast();
  const { syncPendingUiRequestsFromLoadedSessions } = deps;

  async function agentFetch<T>(
    url: string,
    options?: Parameters<typeof $fetch<T>>[1],
  ) {
    try {
      const headers = new Headers(options?.headers as HeadersInit | undefined);
      if (ctx.clientId.value)
        headers.set("X-Agentaz-Client-Id", ctx.clientId.value);
      return await $fetch<T>(`${apiBase()}${url}`, { ...options, headers });
    } catch (error) {
      const data = (error as any)?.data?.data ?? (error as any)?.data;
      const statusCode =
        (error as any)?.statusCode ?? (error as any)?.response?.status;
      const message =
        data?.message ??
        (error instanceof Error ? error.message : String(error));
      ctx.lastError.value = message;
      if (statusCode === 401 && import.meta.client) {
        window.dispatchEvent(new CustomEvent("agentaz-auth-expired"));
      }
      toast.add({
        title: data?.code ?? "agent_http_error",
        description: message,
        color: "error",
      });
      throw error;
    }
  }

  function applyState(
    state: AgentStateResponse | SessionOperationResponse,
    options: { preserveLocalFocusIntent?: boolean } = {},
  ) {
    ctx.activeSessionId.value = resolveActiveSessionFromState(
      state,
      options.preserveLocalFocusIntent,
    );
    ctx.loadedSessions.value = state.loadedSessions;
    ctx.persistedSessions.value = state.persistedSessions;
    syncPendingUiRequestsFromLoadedSessions(state.loadedSessions);
  }

  /**
   * Starts a browser-local session switch intent.
   *
   * Network responses can arrive out of order when the user clicks several
   * sessions quickly. The nonce lets HTTP handlers ignore stale responses, and
   * the remembered session id lets SSE snapshots avoid visually pulling the UI
   * back to an older server-side focus while the latest user choice is still a
   * valid session.
   */
  function beginSessionSwitchIntent(sessionId?: string | null) {
    const nonce = ++ctx.nonces.sessionSwitchRequest;
    if (sessionId) {
      ctx.nonces.latestSessionFocusIntent = { nonce, sessionId };
      ctx.activeSessionId.value = sessionId;
    }
    return nonce;
  }

  /** Returns whether an async session-switch response still matches latest user intent. */
  function isCurrentSessionSwitchIntent(nonce: number) {
    return nonce === ctx.nonces.sessionSwitchRequest;
  }

  /**
   * Updates the latest local focus target after an operation reveals the real
   * loaded session id (for example opening a persisted session by file path).
   */
  function rememberSessionFocusIntent(
    nonce: number,
    sessionId?: string | null,
  ) {
    if (!sessionId || !isCurrentSessionSwitchIntent(nonce)) return;
    ctx.nonces.latestSessionFocusIntent = { nonce, sessionId };
    ctx.activeSessionId.value = sessionId;
  }

  /**
   * Resolves the visible active session for a backend state snapshot.
   *
   * A local focus intent wins while the intended session still exists in the
   * snapshot. If the target disappears (delete/eviction), the intent is cleared
   * and the backend active session/fallback is allowed to take over.
   */
  function resolveActiveSessionFromState(
    state: AgentStateResponse | SessionOperationResponse,
    preserveLocalFocusIntent = false,
  ) {
    const intentSessionId = ctx.nonces.latestSessionFocusIntent?.sessionId;
    if (preserveLocalFocusIntent && intentSessionId) {
      if (
        isDraftSessionId(intentSessionId) ||
        state.activeSessionId === intentSessionId ||
        state.loadedSessions.some(
          (session) => session.sessionId === intentSessionId,
        ) ||
        state.persistedSessions.some(
          (session) => session.sessionId === intentSessionId,
        )
      ) {
        return intentSessionId;
      }
      ctx.nonces.latestSessionFocusIntent = null;
    }

    return (
      state.activeSessionId ??
      (isDraftSessionId(ctx.activeSessionId.value)
        ? ctx.activeSessionId.value
        : null)
    );
  }

  function applyModelState(state: ModelStateResponse) {
    const modelState = ctx.ensureModelState(state.sessionId);
    modelState.models = state.models;
    modelState.currentModel = state.pendingModel ?? state.current ?? null;
    modelState.pendingModelChange = Boolean(state.pendingModel);
    modelState.pendingThinkingChange = Boolean(state.pendingThinkingLevel);
    updateThinkingState(
      state.sessionId,
      state.pendingThinkingLevel ?? state.thinkingLevel,
      state.availableThinkingLevels,
    );
  }

  function updateThinkingState(
    sessionId: string,
    level?: ThinkingLevel,
    levels?: ThinkingLevel[],
  ) {
    const state = ctx.ensureModelState(sessionId);
    if (levels?.length) state.availableThinkingLevels = levels;
    if (level) state.thinkingLevel = level;
    if (!state.availableThinkingLevels.includes(state.thinkingLevel)) {
      state.thinkingLevel = closestThinkingLevel(
        state.thinkingLevel,
        state.availableThinkingLevels,
      );
    }
  }

  return {
    agentFetch,
    applyState,
    beginSessionSwitchIntent,
    isCurrentSessionSwitchIntent,
    rememberSessionFocusIntent,
    resolveActiveSessionFromState,
    applyModelState,
    updateThinkingState,
  };
}

export type AgentazApi = ReturnType<typeof createAgentazApi>;
