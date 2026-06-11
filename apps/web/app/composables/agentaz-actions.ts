import type {
  ContextCompactResponse,
  PendingUiRequest,
  UiMessage,
  UiRequestResponseRequest,
} from "../../types/protocol";
import type { SessionListItem } from "../types/sessions";
import { isDraftSessionId, sessionUrl } from "../utils/app.util";
import { findLoadedSessionByFile } from "../utils/agentaz-session-list";
import type { AgentazContext } from "./agentaz-state";
import type { AgentazApi } from "./agentaz-api";
import type { AgentazMutations } from "./agentaz-mutations";
import type { AgentazSessions } from "./agentaz-sessions";

/**
 * Template-bound actions: the thin wrappers the workspace component binds to
 * (session clicks, *AndClose variants), queue clearing, UI-request responses,
 * and the `loadDummySession` dev helper. Kept here so the noise of fixture data
 * and trivial pass-throughs stays out of the core session/event modules.
 */
export function createAgentazActions(
  ctx: AgentazContext,
  api: AgentazApi,
  mutations: AgentazMutations,
  sessions: AgentazSessions,
) {
  const toast = useToast();
  const { agentFetch, beginSessionSwitchIntent } = api;
  const { removePendingUiRequest } = mutations;
  const {
    createSession,
    openPersistedSession,
    focusSession,
    renameSession,
    deleteSession,
  } = sessions;

  async function handleSessionClick(session: SessionListItem) {
    if (session.isDraft && session.sessionId) {
      beginSessionSwitchIntent(session.sessionId);
      return;
    }
    if (session.isLoaded && session.sessionId) {
      await focusSession(session.sessionId);
    } else if (session.file) {
      const loaded = findLoadedSessionByFile(
        ctx.loadedSessions.value,
        session.file,
      );
      if (loaded) {
        await focusSession(loaded.sessionId);
        return;
      }
      await openPersistedSession(session.file, true, session.sessionId);
    }
  }

  async function createSessionAndClose() {
    await createSession();
  }

  function loadDummySession() {
    const sessionId = "dummy-test-session";
    const now = Date.now();

    ctx.loadedSessions.value = [
      ...ctx.loadedSessions.value.filter((s) => s.sessionId !== sessionId),
      {
        file: sessionId,
        sessionId,
        sessionFile: undefined,
        isWorking: false,
        isStreaming: false,
        pendingMessageCount: 0,
        pendingApprovalCount: 0,
        pendingUiRequests: [],
        extensionWidgets: [],
      },
    ];

    const messages: UiMessage[] = [];
    for (let i = 0; i < 300; i++) {
      const isUser = i % 2 === 0;
      const text = isUser
        ? `This is user message #${i / 2 + 1}. How can I help you test the rendering performance of this chat interface? Let me add some more text to make it realistic. `.repeat(
            3,
          )
        : `This is assistant response #${Math.floor(i / 2) + 1}. Here is a detailed explanation of how the system works. `.repeat(
            5,
          );
      messages.push({
        id: `dummy-msg-${i}`,
        role: isUser ? "user" : "assistant",
        blocks: [
          { id: `dummy-msg-${i}:text:0`, type: "text", text },
          ...(isUser
            ? []
            : [
                {
                  id: `dummy-msg-${i}:thinking:0`,
                  type: "thinking" as const,
                  text: `Thinking process for message ${i}... `.repeat(3),
                  collapsed: true,
                },
              ]),
        ],
        createdAt: now - (300 - i) * 60_000,
      });
    }

    ctx.messagesBySessionId.value[sessionId] = messages;
    ctx.activeSessionId.value = sessionId;
  }

  async function openPersistedSessionAndClose(sessionFile: string) {
    await openPersistedSession(sessionFile);
  }

  async function focusSessionAndClose(sessionId: string) {
    await focusSession(sessionId);
  }

  async function renameSessionAndClose(sessionFile: string, name: string) {
    await renameSession(sessionFile, name);
  }

  async function deleteSessionAndClose(session: SessionListItem) {
    await deleteSession(session);
  }

  async function clearActiveQueue() {
    if (
      ctx.activeSessionId.value &&
      !isDraftSessionId(ctx.activeSessionId.value)
    )
      await agentFetch(sessionUrl(ctx.activeSessionId.value, "/queue/clear"), {
        method: "POST",
      });
  }

  async function compactActiveContext() {
    const sessionId = ctx.activeSessionId.value;
    if (
      !sessionId ||
      isDraftSessionId(sessionId) ||
      !ctx.activeLoadedSession.value ||
      ctx.status.value !== "connected" ||
      ctx.isActiveSessionWorking.value
    ) {
      return;
    }

    const result = await agentFetch<ContextCompactResponse>(
      sessionUrl(sessionId, "/compact"),
      { method: "POST", body: {} },
    );
    await sessions.refreshHistory(result.sessionId, true);
    toast.add({
      title: "Context compacted",
      description: `Compacted from ${result.tokensBefore.toLocaleString()} context tokens.`,
      color: "success",
    });
  }

  async function respondToUiRequest(
    request: PendingUiRequest,
    value?: string | boolean,
  ) {
    let body: UiRequestResponseRequest;
    if (request.type === "ui_select_request") {
      body = {
        kind: "select",
        selected: typeof value === "string" ? value : undefined,
      };
    } else if (request.type === "ui_input_request") {
      body = {
        kind: "input",
        value: typeof value === "string" ? value : undefined,
      };
    } else {
      body = { kind: "confirm", confirmed: value === true };
    }

    await agentFetch(
      sessionUrl(
        request.sessionId,
        `/ui-requests/${encodeURIComponent(request.requestId)}/response`,
      ),
      { method: "POST", body },
    );
    removePendingUiRequest(request.sessionId, request.requestId);
  }

  return {
    handleSessionClick,
    createSessionAndClose,
    loadDummySession,
    openPersistedSessionAndClose,
    focusSessionAndClose,
    renameSessionAndClose,
    deleteSessionAndClose,
    clearActiveQueue,
    compactActiveContext,
    respondToUiRequest,
  };
}

export type AgentazActions = ReturnType<typeof createAgentazActions>;
