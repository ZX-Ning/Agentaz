import type {
  AgentStateResponse,
  MessageSubmitRequest,
  ModelSetRequest,
  ModelStateResponse,
  ServerEvent,
  ServerHello,
  SessionHistoryResponse,
  SessionListItem,
  SessionOperationResponse,
  ThinkingLevel,
  UiLoadedSession,
  UiMessage,
  UiRequestResponseRequest,
  UiSessionSummary,
  UiExtensionWidget,
} from "../../types/protocol";
import {
  type SessionModelState,
  thinkingOptions,
  defaultModelState,
  isDraftSessionId,
  routeSessionId,
  browserPathForSession,
  createDraftSessionId,
  modelKey,
  sessionUrl,
  sessionTitle,
  closestThinkingLevel,
  isThinkingLevel,
} from "../utils/app.util";
import {
  buildUnifiedSessions,
  findLoadedSessionByFile,
} from "../utils/agentaz-session-list";
import {
  appendMessageBlockDelta,
  ensureMessageBucket,
  upsertMessage,
  upsertMessageBlock,
} from "../utils/agentaz-transcript";

type PendingUiRequest =
  | Extract<ServerEvent, { type: "ui_select_request" }>
  | Extract<ServerEvent, { type: "ui_input_request" }>
  | Extract<ServerEvent, { type: "ui_confirm_request" }>;

/**
 * Creates the page-level Agentaz application controller.
 *
 * This composable is intentionally a single-owner controller for `app.vue`, not
 * a reusable shared-state composable. Each invocation creates a fresh set of
 * refs, registers route watchers and component lifecycle hooks, opens a browser
 * WebSocket connection to `/api/agent/ws`, and closes that socket when the owner
 * component unmounts. Calling it from multiple components would create multiple
 * independent controller instances and duplicate WebSocket subscriptions.
 *
 * Keep cross-component UI state flowing through the values returned to
 * `app.vue` and passed down as props/events. If nested components need more
 * behavior, prefer adding explicit returned fields or extracting pure helper
 * functions instead of calling this controller again.
 */
export function useAgentazAppController() {
  const toast = useToast();
  const route = useRoute();
  const router = useRouter();

  const status = ref<"connecting" | "connected" | "disconnected" | "error">(
    "connecting",
  );
  const hello = ref<ServerHello | null>(null);
  const clientId = ref("");
  const activeSessionId = ref<string | null>(null);
  const loadedSessions = ref<UiLoadedSession[]>([]);
  const persistedSessions = ref<UiSessionSummary[]>([]);
  const messagesBySessionId = ref<Record<string, UiMessage[]>>({});
  const modelStateBySessionId = ref<Record<string, SessionModelState>>({});
  const pendingUiRequestsBySessionId = ref<Record<string, PendingUiRequest[]>>(
    {},
  );
  const promptText = ref("");
  const lastError = ref<string | null>(null);
  const socket = shallowRef<WebSocket | null>(null);
  const hasAppliedInitialRoute = ref(false);
  const isSyncingBrowserRoute = ref(false);

  // --- computed ---

  const activeLoadedSession = computed(
    () =>
      loadedSessions.value.find(
        (session) => session.sessionId === activeSessionId.value,
      ) ?? null,
  );
  const activeSessionTitle = computed(() => {
    const sessionId = activeSessionId.value;
    if (!sessionId || isDraftSessionId(sessionId)) return "New session";
    const loaded = activeLoadedSession.value;
    if (loaded) return sessionTitle(loaded);
    const persisted = persistedSessions.value.find(
      (session) => session.sessionId === sessionId,
    );
    if (persisted) return sessionTitle(persisted);
    return `Session ${sessionId}`;
  });
  const isActiveDraftSession = computed(() =>
    isDraftSessionId(activeSessionId.value),
  );
  const activeMessages = computed(() =>
    activeSessionId.value
      ? (messagesBySessionId.value[activeSessionId.value] ?? [])
      : [],
  );
  const activeModelState = computed(() =>
    activeSessionId.value
      ? ensureModelState(activeSessionId.value)
      : defaultModelState(),
  );
  const activePendingUiRequests = computed(() =>
    activeSessionId.value
      ? (pendingUiRequestsBySessionId.value[activeSessionId.value] ?? [])
      : [],
  );
  const activeExtensionWidgets = computed(() =>
    activeLoadedSession.value ? activeLoadedSession.value.extensionWidgets : [],
  );
  const unifiedSessions = computed(() =>
    buildUnifiedSessions(
      activeSessionId.value,
      loadedSessions.value,
      persistedSessions.value,
    ),
  );

  const models = computed(() => activeModelState.value.models);
  const currentModel = computed(() => activeModelState.value.currentModel);
  const currentThinkingLevel = computed(
    () => activeModelState.value.thinkingLevel,
  );
  const availableThinkingLevels = computed(
    () => activeModelState.value.availableThinkingLevels,
  );
  const pendingModelChange = computed(
    () => activeModelState.value.pendingModelChange,
  );
  const pendingThinkingChange = computed(
    () => activeModelState.value.pendingThinkingChange,
  );
  const isStreaming = computed(() =>
    Boolean(activeLoadedSession.value?.isStreaming),
  );
  const pendingMessageCount = computed(
    () => activeLoadedSession.value?.pendingMessageCount ?? 0,
  );
  const pendingApprovalCount = computed(
    () =>
      activeLoadedSession.value?.pendingApprovalCount ??
      activePendingUiRequests.value.length,
  );
  const selectedModelKey = computed(() =>
    currentModel.value ? modelKey(currentModel.value) : "",
  );
  const visibleThinkingOptions = computed(() => {
    const levels =
      availableThinkingLevels.value.length > 0
        ? availableThinkingLevels.value
        : ["off"];
    return thinkingOptions.filter((option) => levels.includes(option.value));
  });
  const modelOptions = computed(() =>
    models.value.map((model) => ({
      value: modelKey(model),
      label: `${model.name || model.id} - ${model.provider}`,
      description: `${model.provider}/${model.id}`,
      model,
    })),
  );
  // --- state helpers ---

  function ensureModelState(sessionId: string) {
    modelStateBySessionId.value[sessionId] ??= defaultModelState();
    return modelStateBySessionId.value[sessionId];
  }

  // --- API layer ---

  async function agentFetch<T>(
    url: string,
    options?: Parameters<typeof $fetch<T>>[1],
  ) {
    try {
      const headers = new Headers(options?.headers as HeadersInit | undefined);
      if (clientId.value) headers.set("X-Agentaz-Client-Id", clientId.value);
      return await $fetch<T>(url, { ...options, headers });
    } catch (error) {
      const data = (error as any)?.data?.data ?? (error as any)?.data;
      const statusCode =
        (error as any)?.statusCode ?? (error as any)?.response?.status;
      const message =
        data?.message ??
        (error instanceof Error ? error.message : String(error));
      lastError.value = message;
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

  function applyState(state: AgentStateResponse | SessionOperationResponse) {
    activeSessionId.value =
      state.activeSessionId ??
      (isDraftSessionId(activeSessionId.value) ? activeSessionId.value : null);
    loadedSessions.value = state.loadedSessions;
    persistedSessions.value = state.persistedSessions;
  }

  function applyModelState(state: ModelStateResponse) {
    const modelState = ensureModelState(state.sessionId);
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
    const state = ensureModelState(sessionId);
    if (levels?.length) state.availableThinkingLevels = levels;
    if (level) state.thinkingLevel = level;
    if (!state.availableThinkingLevels.includes(state.thinkingLevel)) {
      state.thinkingLevel = closestThinkingLevel(
        state.thinkingLevel,
        state.availableThinkingLevels,
      );
    }
  }

  // --- session mutation helpers ---

  function upsertLoadedSession(
    sessionId: string,
    patch: Partial<UiLoadedSession>,
  ) {
    const index = loadedSessions.value.findIndex(
      (session) => session.sessionId === sessionId,
    );
    if (index === -1) {
      loadedSessions.value.push({
        file: patch.file ?? patch.sessionFile ?? sessionId,
        sessionId,
        sessionFile: patch.sessionFile,
        isWorking: patch.isWorking ?? false,
        isStreaming: patch.isStreaming ?? false,
        pendingMessageCount: patch.pendingMessageCount ?? 0,
        pendingApprovalCount: patch.pendingApprovalCount ?? 0,
        extensionWidgets: patch.extensionWidgets ?? [],
        controlOwnerClientId: patch.controlOwnerClientId,
        controlledByCurrentClient: patch.controlledByCurrentClient,
      });
      return;
    }
    const current = loadedSessions.value[index];
    if (!current) return;
    loadedSessions.value[index] = {
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
    if (!loadedSessions.value.some((item) => item.sessionId === sessionId)) {
      upsertLoadedSession(sessionId, {});
    }
    const currentSession = loadedSessions.value.find(
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
    const requests = pendingUiRequestsBySessionId.value[event.sessionId] ?? [];
    const nextRequests = [
      ...requests.filter((item) => item.requestId !== event.requestId),
      event,
    ];
    pendingUiRequestsBySessionId.value[event.sessionId] = nextRequests;
    upsertLoadedSession(event.sessionId, {
      pendingApprovalCount: nextRequests.length,
    });
  }

  function removePendingUiRequest(sessionId: string, requestId: string) {
    const nextRequests = (
      pendingUiRequestsBySessionId.value[sessionId] ?? []
    ).filter((item) => item.requestId !== requestId);
    pendingUiRequestsBySessionId.value[sessionId] = nextRequests;
    upsertLoadedSession(sessionId, {
      pendingApprovalCount: nextRequests.length,
    });
  }

  // --- session operations ---

  async function refreshHistory(sessionId: string) {
    if (isDraftSessionId(sessionId)) return;
    if (messagesBySessionId.value[sessionId]?.length) return;
    const history = await agentFetch<SessionHistoryResponse>(
      sessionUrl(sessionId, "/history"),
    );
    messagesBySessionId.value[sessionId] = history.messages;
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
      modelStateBySessionId.value[sessionId]?.models.length
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
  ) {
    const state = await agentFetch<SessionOperationResponse>(path, options);
    applyState(state);
    if (state.activeSessionId)
      await refreshSessionDetails(state.activeSessionId);
    return state;
  }

  // --- session management ---

  async function syncBrowserRouteToSession(
    sessionId?: string | null,
    mode: "push" | "replace" = "replace",
  ) {
    const targetPath = browserPathForSession(sessionId);
    if (route.path === targetPath) return;
    isSyncingBrowserRoute.value = true;
    try {
      await router[mode](targetPath);
    } finally {
      await nextTick();
      isSyncingBrowserRoute.value = false;
    }
  }

  function createDraftSession() {
    const previousModelState = activeSessionId.value
      ? modelStateBySessionId.value[activeSessionId.value]
      : undefined;
    const sessionId = createDraftSessionId();
    activeSessionId.value = sessionId;
    ensureMessageBucket(messagesBySessionId.value, sessionId);
    modelStateBySessionId.value[sessionId] = previousModelState
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
    if (!activeSessionId.value) return createDraftSession();
    return activeSessionId.value;
  }

  async function materializeDraftSession(draftSessionId: string) {
    const draftModelState = modelStateBySessionId.value[draftSessionId];
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

    messagesBySessionId.value[sessionId] =
      messagesBySessionId.value[draftSessionId] ?? [];
    delete messagesBySessionId.value[draftSessionId];
    modelStateBySessionId.value[sessionId] =
      modelStateBySessionId.value[draftSessionId] ?? defaultModelState();
    delete modelStateBySessionId.value[draftSessionId];
    activeSessionId.value = sessionId;
    applyState(state);
    activeSessionId.value = sessionId;
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
    await syncBrowserRouteToSession(activeSessionId.value, "push");
  }

  async function openPersistedSession(sessionFile: string, syncRoute = true) {
    const state = await postSessionOperation("/api/agent/sessions", {
      method: "POST",
      body: { sessionFile },
    });
    if (syncRoute) {
      await syncBrowserRouteToSession(
        state.sessionId ?? state.activeSessionId,
        "push",
      );
    }
  }

  async function focusSession(sessionId: string, syncRoute = true) {
    activeSessionId.value = sessionId;
    await postSessionOperation(sessionUrl(sessionId, "/focus"), {
      method: "POST",
    });
    if (syncRoute) await syncBrowserRouteToSession(sessionId, "push");
  }

  // --- event handling ---

  async function sendPrompt() {
    let sessionId = activeSessionId.value;
    const text = promptText.value.trim();
    if (!sessionId || !text) return;

    const localMessageId = `local-${Date.now()}`;
    ensureMessageBucket(messagesBySessionId.value, sessionId).push({
      id: localMessageId,
      role: "user",
      blocks: [{ id: `${localMessageId}:text`, type: "text", text }],
      createdAt: Date.now(),
    });

    if (isDraftSessionId(sessionId)) {
      sessionId = await materializeDraftSession(sessionId);
    }

    const body: MessageSubmitRequest = { mode: "prompt", text };
    await agentFetch(sessionUrl(sessionId, "/messages"), {
      method: "POST",
      body,
    });
    promptText.value = "";
  }

  async function submitComposer() {
    const sessionId = activeSessionId.value;
    if (!sessionId) return;
    if (!isDraftSessionId(sessionId) && isStreaming.value) {
      await agentFetch(sessionUrl(sessionId, "/abort"), { method: "POST" });
      return;
    }
    await sendPrompt();
  }

  function handleEvent(event: ServerEvent) {
    if (event.type === "hello") {
      hello.value = event;
      clientId.value = event.clientId;
      applyState(event.state);
      return;
    }

    if (event.type === "state_snapshot") {
      const previousActiveSessionId = activeSessionId.value;
      const state = event.state;
      if (!isDraftSessionId(activeSessionId.value)) {
        activeSessionId.value = state.activeSessionId ?? activeSessionId.value;
      }
      loadedSessions.value = state.loadedSessions;
      if (state.persistedSessions.length > 0)
        persistedSessions.value = state.persistedSessions;
      if (
        activeSessionId.value &&
        !isDraftSessionId(activeSessionId.value) &&
        activeSessionId.value !== previousActiveSessionId
      ) {
        void refreshSessionDetails(activeSessionId.value);
      }
      if (
        hasAppliedInitialRoute.value &&
        activeSessionId.value &&
        !isDraftSessionId(activeSessionId.value)
      ) {
        void syncBrowserRouteToSession(activeSessionId.value, "replace");
      }
      return;
    }

    if (event.type === "control_changed") {
      upsertLoadedSession(event.sessionId, {
        controlOwnerClientId: event.controlOwnerClientId,
        controlledByCurrentClient:
          event.controlOwnerClientId === clientId.value,
      });
      return;
    }

    if (event.type === "message_upsert") {
      upsertMessage(messagesBySessionId.value, event.sessionId, event.message);
      return;
    }

    if (event.type === "message_block_upsert") {
      upsertMessageBlock(
        messagesBySessionId.value,
        event.sessionId,
        event.messageId,
        event.block,
      );
      return;
    }

    if (event.type === "message_block_delta") {
      appendMessageBlockDelta(
        messagesBySessionId.value,
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
        const mState = ensureModelState(event.sessionId);
        const shouldRefreshModelState =
          !event.isStreaming &&
          (mState.pendingModelChange || mState.pendingThinkingChange);
        upsertLoadedSession(event.sessionId, {
          isStreaming: event.isStreaming,
          pendingMessageCount: event.pendingMessageCount,
          pendingApprovalCount: event.pendingApprovalCount ?? 0,
        });
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
      lastError.value = event.message;
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

  function connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/agent/ws`,
    );
    socket.value = ws;

    return new Promise<ServerHello>((resolve, reject) => {
      ws.addEventListener("open", () => {
        status.value = "connected";
      });

      ws.addEventListener("message", (message) => {
        try {
          const event = JSON.parse(message.data) as ServerEvent;
          handleEvent(event);
          if (event.type === "hello") resolve(event);
        } catch (error) {
          lastError.value =
            error instanceof Error ? error.message : String(error);
          reject(error);
        }
      });

      ws.addEventListener("close", () => {
        status.value = "disconnected";
        reject(new Error("WebSocket connection closed before hello."));
      });

      ws.addEventListener("error", () => {
        status.value = "error";
        lastError.value = "WebSocket connection failed.";
        reject(new Error("WebSocket connection failed."));
      });
    });
  }

  // --- routing ---

  async function activateSessionFromRoute(sessionId: string) {
    if (activeSessionId.value === sessionId && !isDraftSessionId(sessionId)) {
      await refreshSessionDetails(sessionId);
      return true;
    }

    if (
      loadedSessions.value.some((session) => session.sessionId === sessionId)
    ) {
      await focusSession(sessionId, false);
      return true;
    }

    const persisted = persistedSessions.value.find(
      (session) => session.sessionId === sessionId,
    );
    if (!persisted) return false;

    await openPersistedSession(persisted.file, false);
    return true;
  }

  async function applyBrowserRoute() {
    const sessionId = routeSessionId(route.path);
    if (sessionId) {
      const activated = await activateSessionFromRoute(sessionId);
      if (activated) return;

      toast.add({
        title: "Session not found",
        description: `No session is available for ${sessionId}.`,
        color: "error",
      });
    }

    await refreshDraftModelState(createDraftSession());
    await syncBrowserRouteToSession(activeSessionId.value, "replace");
  }

  async function applyInitialRoute(state: AgentStateResponse) {
    const sessionId = routeSessionId(route.path);
    if (sessionId) {
      const activated = await activateSessionFromRoute(sessionId);
      if (!activated) await applyBrowserRoute();
    } else {
      await refreshActiveStateDetails(state);
      await syncBrowserRouteToSession(activeSessionId.value, "replace");
    }
    hasAppliedInitialRoute.value = true;
  }

  // --- user actions (template-bound) ---

  async function handleSessionClick(session: SessionListItem) {
    if (session.isDraft && session.sessionId) {
      activeSessionId.value = session.sessionId;
      return;
    }
    if (session.isLoaded && session.sessionId) {
      await focusSession(session.sessionId);
    } else if (session.file) {
      const loaded = findLoadedSessionByFile(
        loadedSessions.value,
        session.file,
      );
      if (loaded) {
        await focusSession(loaded.sessionId);
        return;
      }
      await openPersistedSession(session.file);
    }
  }

  async function handleModelSelect(value: unknown) {
    const sessionId = activeSessionId.value;
    if (!sessionId || typeof value !== "string") return;
    const option = modelOptions.value.find((item) => item.value === value);
    if (!option || modelKey(option.model) === selectedModelKey.value) return;
    if (isDraftSessionId(sessionId)) {
      const state = ensureModelState(sessionId);
      state.currentModel = option.model;
      state.pendingModelChange = false;
      updateThinkingState(
        sessionId,
        state.thinkingLevel,
        option.model.availableThinkingLevels,
      );
      return;
    }

    const body: ModelSetRequest = {
      provider: option.model.provider,
      id: option.model.id,
    };
    applyModelState(
      await agentFetch<ModelStateResponse>(sessionUrl(sessionId, "/model"), {
        method: "PUT",
        body,
      }),
    );
  }

  async function handleThinkingSelect(value: unknown) {
    const sessionId = activeSessionId.value;
    if (!sessionId || !isThinkingLevel(value)) return;
    if (isDraftSessionId(sessionId)) {
      updateThinkingState(sessionId, value);
      return;
    }
    applyModelState(
      await agentFetch<ModelStateResponse>(sessionUrl(sessionId, "/thinking"), {
        method: "PUT",
        body: { level: value },
      }),
    );
  }

  async function createSessionAndClose() {
    await createSession();
  }

  function loadDummySession() {
    const sessionId = "dummy-test-session";
    const now = Date.now();

    loadedSessions.value = [
      ...loadedSessions.value.filter((s) => s.sessionId !== sessionId),
      {
        file: sessionId,
        sessionId,
        sessionFile: undefined,
        isWorking: false,
        isStreaming: false,
        pendingMessageCount: 0,
        pendingApprovalCount: 0,
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

    messagesBySessionId.value[sessionId] = messages;
    activeSessionId.value = sessionId;
  }

  async function openPersistedSessionAndClose(sessionFile: string) {
    await openPersistedSession(sessionFile);
  }

  async function focusSessionAndClose(sessionId: string) {
    await focusSession(sessionId);
  }

  async function clearActiveQueue() {
    if (activeSessionId.value && !isDraftSessionId(activeSessionId.value))
      await agentFetch(sessionUrl(activeSessionId.value, "/queue/clear"), {
        method: "POST",
      });
  }

  async function respondToUiRequest(
    request: PendingUiRequest,
    value?: string | boolean,
  ) {
    let body: UiRequestResponseRequest;
    if (request.type === "ui_select_request") {
      body = { selected: typeof value === "string" ? value : undefined };
    } else if (request.type === "ui_input_request") {
      body = { value: typeof value === "string" ? value : undefined };
    } else {
      body = { confirmed: value === true };
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

  // --- lifecycle ---

  watch(
    () => route.path,
    () => {
      if (!hasAppliedInitialRoute.value || isSyncingBrowserRoute.value) return;
      void applyBrowserRoute();
    },
  );

  onMounted(() => {
    connectWebSocket()
      .then((event) => applyInitialRoute(event.state))
      .catch(() => {
        status.value = "error";
      });
  });

  onBeforeUnmount(() => {
    socket.value?.close();
  });

  return {
    // ref state
    status,
    hello,
    clientId,
    activeSessionId,
    loadedSessions,
    persistedSessions,
    messagesBySessionId,
    modelStateBySessionId,
    pendingUiRequestsBySessionId,
    promptText,
    lastError,
    socket,
    hasAppliedInitialRoute,
    isSyncingBrowserRoute,
    // computed
    activeLoadedSession,
    activeSessionTitle,
    isActiveDraftSession,
    activeMessages,
    activeModelState,
    activePendingUiRequests,
    activeExtensionWidgets,
    unifiedSessions,
    models,
    currentModel,
    currentThinkingLevel,
    availableThinkingLevels,
    pendingModelChange,
    pendingThinkingChange,
    isStreaming,
    pendingMessageCount,
    pendingApprovalCount,
    selectedModelKey,
    visibleThinkingOptions,
    modelOptions,
    // functions
    handleSessionClick,
    handleModelSelect,
    handleThinkingSelect,
    createSessionAndClose,
    loadDummySession,
    openPersistedSessionAndClose,
    focusSessionAndClose,
    clearActiveQueue,
    respondToUiRequest,
    submitComposer,
  };
}
