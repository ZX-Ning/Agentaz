<script setup lang="ts">
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
  UiModel,
  UiRequestResponseRequest,
  UiSessionSummary,
  UiBlock,
} from "../types/protocol";

type SessionModelState = {
  models: UiModel[];
  currentModel: UiModel | null;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
  pendingModelChange: boolean;
  pendingThinkingChange: boolean;
};

type PendingUiRequest =
  | Extract<ServerEvent, { type: "ui_select_request" }>
  | Extract<ServerEvent, { type: "ui_input_request" }>
  | Extract<ServerEvent, { type: "ui_confirm_request" }>;

const DRAFT_SESSION_PREFIX = "draft-session-";
const toast = useToast();
const colorMode = useColorMode();
const isDark = computed(() => colorMode.value === "dark");

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

const isSidebarOpen = ref(false);
const isStatusMenuOpen = ref(false);

const thinkingOptions: Array<{ value: ThinkingLevel; label: string }> = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

const activeLoadedSession = computed(
  () =>
    loadedSessions.value.find(
      (session) => session.sessionId === activeSessionId.value,
    ) ?? null,
);
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
const unifiedSessions = computed(() => {
  const list: SessionListItem[] = [];
  const loadedByFile = new Map<string, UiLoadedSession>();

  if (isActiveDraftSession.value && activeSessionId.value) {
    list.push({
      id: activeSessionId.value,
      file: null,
      sessionId: activeSessionId.value,
      isDraft: true,
      isLoaded: false,
      isActive: true,
      isWorking: false,
      isStreaming: false,
      pendingApprovalCount: 0,
      title: "New session",
      updatedAt: Date.now(),
    });
  }

  for (const session of loadedSessions.value) {
    const file = session.sessionFile ?? session.file;
    if (file) loadedByFile.set(file, session);
  }

  for (const persisted of persistedSessions.value) {
    const loaded = findLoadedSessionByFile(persisted.file, loadedByFile);
    list.push(toSessionListItem(loaded ?? persisted, loaded, persisted));
  }

  for (const loaded of loadedSessions.value) {
    const file = loaded.sessionFile ?? loaded.file;
    if (
      file &&
      persistedSessions.value.some((session) => session.file === file)
    )
      continue;
    list.push(toSessionListItem(loaded, loaded));
  }

  return list.sort(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
  );
});

async function handleSessionClick(session: SessionListItem) {
  if (session.isDraft && session.sessionId) {
    activeSessionId.value = session.sessionId;
    isSidebarOpen.value = false;
    return;
  }
  if (session.isLoaded && session.sessionId) {
    await focusSessionAndClose(session.sessionId);
  } else if (session.file) {
    const loaded = findLoadedSessionByFile(session.file);
    if (loaded) {
      await focusSessionAndClose(loaded.sessionId);
      return;
    }
    await openPersistedSessionAndClose(session.file);
  }
}
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
const canSubmitToActiveSession = computed(() => Boolean(activeSessionId.value));
const hasMessages = computed(() => activeMessages.value.length > 0);
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
const statusColor = computed(() => {
  if (status.value === "connected") return "success";
  if (status.value === "connecting") return "warning";
  if (status.value === "error") return "error";
  return "neutral";
});
const statusLabel = computed(() => {
  if (status.value === "connected")
    return isStreaming.value ? "Streaming" : "Connected";
  if (status.value === "connecting") return "Connecting";
  if (status.value === "error") return "Error";
  return "Disconnected";
});

function defaultModelState(): SessionModelState {
  return {
    models: [],
    currentModel: null,
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    pendingModelChange: false,
    pendingThinkingChange: false,
  };
}

function ensureModelState(sessionId: string) {
  modelStateBySessionId.value[sessionId] ??= defaultModelState();
  return modelStateBySessionId.value[sessionId];
}

function ensureMessageBucket(sessionId: string) {
  messagesBySessionId.value[sessionId] ??= [];
  return messagesBySessionId.value[sessionId];
}

function isDraftSessionId(sessionId?: string | null) {
  return Boolean(sessionId?.startsWith(DRAFT_SESSION_PREFIX));
}

function createDraftSessionId() {
  return `${DRAFT_SESSION_PREFIX}${Date.now()}`;
}

function createDraftSession() {
  const previousModelState = activeSessionId.value
    ? modelStateBySessionId.value[activeSessionId.value]
    : undefined;
  const sessionId = createDraftSessionId();
  activeSessionId.value = sessionId;
  ensureMessageBucket(sessionId);
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
    {
      method: "POST",
    },
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
      await agentFetch<ModelStateResponse>(sessionUrl(sessionId, "/thinking"), {
        method: "PUT",
        body: { level: draftThinkingLevel },
      }),
    );
  }
  return sessionId;
}

function modelKey(model: UiModel) {
  return JSON.stringify([model.provider, model.id]);
}

function sessionUrl(sessionId: string, suffix = "") {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

function sessionTitle(session: UiLoadedSession | UiSessionSummary) {
  return (
    session.name ||
    session.firstMessage ||
    ("sessionId" in session
      ? session.sessionId.slice(0, 8)
      : "Untitled session")
  );
}

function findLoadedSessionByFile(
  file: string,
  indexedByFile?: Map<string, UiLoadedSession>,
) {
  const indexed = indexedByFile?.get(file);
  if (indexed) return indexed;
  return loadedSessions.value.find(
    (session) =>
      session.sessionFile === file ||
      session.file === file ||
      session.sessionId === file,
  );
}

function toSessionListItem(
  source: UiLoadedSession | UiSessionSummary,
  loaded?: UiLoadedSession,
  persisted?: UiSessionSummary,
): SessionListItem {
  const sessionFile =
    loaded?.sessionFile ??
    loaded?.file ??
    persisted?.file ??
    ("file" in source ? source.file : null);
  const sessionId = loaded?.sessionId ?? null;
  return {
    id: sessionId ?? sessionFile ?? sessionTitle(source),
    file: sessionFile,
    sessionId,
    isDraft: false,
    isLoaded: Boolean(loaded),
    isActive: Boolean(sessionId && sessionId === activeSessionId.value),
    isWorking: loaded?.isWorking ?? false,
    isStreaming: loaded?.isStreaming ?? false,
    pendingApprovalCount: loaded?.pendingApprovalCount ?? 0,
    title: loaded
      ? sessionTitle({ ...persisted, ...loaded })
      : sessionTitle(source),
    updatedAt:
      loaded?.updatedAt ??
      persisted?.updatedAt ??
      persisted?.createdAt ??
      ("updatedAt" in source ? source.updatedAt : undefined) ??
      ("createdAt" in source ? source.createdAt : undefined),
  };
}

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
    const message =
      data?.message ?? (error instanceof Error ? error.message : String(error));
    lastError.value = message;
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

async function refreshState() {
  const state = await agentFetch<AgentStateResponse>("/api/agent/state");
  applyState(state);
  await refreshActiveStateDetails(state);
}

async function refreshActiveStateDetails(state: AgentStateResponse) {
  if (state.activeSessionId) {
    await refreshSessionDetails(state.activeSessionId);
  } else {
    await refreshDraftModelState(ensureDraftSession());
  }
}

async function refreshSessionDetails(sessionId: string) {
  if (isDraftSessionId(sessionId)) return;
  await Promise.all([refreshHistory(sessionId), refreshModelState(sessionId)]);
}

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

async function refreshDraftModelState(sessionId: string) {
  if (
    !isDraftSessionId(sessionId) ||
    modelStateBySessionId.value[sessionId]?.models.length
  )
    return;
  const state = await agentFetch<ModelStateResponse>("/api/agent/models");
  applyModelState({ ...state, sessionId });
}

async function postSessionOperation(
  path: string,
  options?: Parameters<typeof $fetch<SessionOperationResponse>>[1],
) {
  const state = await agentFetch<SessionOperationResponse>(path, options);
  applyState(state);
  if (state.activeSessionId) await refreshSessionDetails(state.activeSessionId);
}

async function sendPrompt() {
  let sessionId = activeSessionId.value;
  const text = promptText.value.trim();
  if (!sessionId || !text) return;

  const localMessageId = `local-${Date.now()}`;
  ensureMessageBucket(sessionId).push({
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

function toggleTheme() {
  colorMode.preference = isDark.value ? "light" : "dark";
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

function closestThinkingLevel(
  level: ThinkingLevel,
  availableLevels: ThinkingLevel[],
) {
  if (availableLevels.includes(level)) return level;
  const requestedIndex = thinkingOptions.findIndex(
    (option) => option.value === level,
  );
  for (let index = requestedIndex; index < thinkingOptions.length; index++) {
    const option = thinkingOptions[index];
    if (option && availableLevels.includes(option.value)) return option.value;
  }
  for (let index = requestedIndex - 1; index >= 0; index--) {
    const option = thinkingOptions[index];
    if (option && availableLevels.includes(option.value)) return option.value;
  }
  return availableLevels[0] ?? "off";
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

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return thinkingOptions.some((option) => option.value === value);
}

async function createSession() {
  await refreshDraftModelState(createDraftSession());
}

async function openPersistedSession(sessionFile: string) {
  await postSessionOperation("/api/agent/sessions", {
    method: "POST",
    body: { sessionFile },
  });
}

async function focusSession(sessionId: string) {
  activeSessionId.value = sessionId;
  await postSessionOperation(sessionUrl(sessionId, "/focus"), {
    method: "POST",
  });
}

async function createSessionAndClose() {
  await createSession();
  isSidebarOpen.value = false;
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
  isSidebarOpen.value = false;
}

async function openPersistedSessionAndClose(sessionFile: string) {
  await openPersistedSession(sessionFile);
  isSidebarOpen.value = false;
}

async function focusSessionAndClose(sessionId: string) {
  await focusSession(sessionId);
  isSidebarOpen.value = false;
}

async function clearActiveQueue() {
  if (activeSessionId.value && !isDraftSessionId(activeSessionId.value))
    await agentFetch(sessionUrl(activeSessionId.value, "/queue/clear"), {
      method: "POST",
    });
}

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

function upsertMessage(sessionId: string, message: UiMessage) {
  const bucket = ensureMessageBucket(sessionId);
  const index = bucket.findIndex((item) => item.id === message.id);
  if (index === -1) bucket.push(message);
  else bucket[index] = message;
}

function ensureTranscriptMessage(sessionId: string, messageId: string) {
  const bucket = ensureMessageBucket(sessionId);
  let message = bucket.find((item) => item.id === messageId);
  if (!message) {
    message = {
      id: messageId,
      role: "assistant",
      blocks: [],
      createdAt: Date.now(),
    };
    bucket.push(message);
  }
  return message;
}

function upsertMessageBlock(
  sessionId: string,
  messageId: string,
  block: UiBlock,
) {
  const message = ensureTranscriptMessage(sessionId, messageId);
  const index = message.blocks.findIndex(
    (item) => item.id === block.id || areSameToolBlock(item, block),
  );
  if (index === -1) message.blocks.push(block);
  else message.blocks[index] = block;
}

function areSameToolBlock(left: UiBlock, right: UiBlock) {
  if (left.type === "tool_call" && right.type === "tool_call")
    return left.toolCallId === right.toolCallId;
  if (left.type === "tool_result" && right.type === "tool_result")
    return left.toolCallId === right.toolCallId;
  return false;
}

function appendMessageBlockDelta(
  sessionId: string,
  messageId: string,
  blockId: string,
  blockType: "text" | "thinking",
  delta: string,
) {
  const message = ensureTranscriptMessage(sessionId, messageId);
  let block = message.blocks.find((item) => item.id === blockId);
  if (!block) {
    block =
      blockType === "text"
        ? { id: blockId, type: "text", text: "" }
        : { id: blockId, type: "thinking", text: "", collapsed: true };
    message.blocks.push(block);
  }
  if (block.type === "text" || block.type === "thinking") {
    block.text += delta;
  }
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
  upsertLoadedSession(sessionId, { pendingApprovalCount: nextRequests.length });
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
    return;
  }

  if (event.type === "control_changed") {
    upsertLoadedSession(event.sessionId, {
      controlOwnerClientId: event.controlOwnerClientId,
      controlledByCurrentClient: event.controlOwnerClientId === clientId.value,
    });
    return;
  }

  if (event.type === "message_upsert") {
    upsertMessage(event.sessionId, event.message);
    return;
  }

  if (event.type === "message_block_upsert") {
    upsertMessageBlock(event.sessionId, event.messageId, event.block);
    return;
  }

  if (event.type === "message_block_delta") {
    appendMessageBlockDelta(
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
      const state = ensureModelState(event.sessionId);
      const shouldRefreshModelState =
        !event.isStreaming &&
        (state.pendingModelChange || state.pendingThinkingChange);
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
  }
}

function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/api/agent/ws`);
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

onMounted(() => {
  connectWebSocket()
    .then((event) => refreshActiveStateDetails(event.state))
    .catch(() => {
      status.value = "error";
    });
});

onBeforeUnmount(() => {
  socket.value?.close();
});
</script>

<template>
  <UApp>
    <div
      class="chat-shell flex h-screen overflow-hidden bg-background text-foreground"
    >
      <AppSidebar
        v-model:open="isSidebarOpen"
        :client-id="clientId"
        :sessions="unifiedSessions"
        :working-dir="hello?.cwd ?? 'Waiting for backend...'"
        @create="createSessionAndClose"
        @load-dummy="loadDummySession"
        @select="handleSessionClick"
      />

      <main class="flex min-w-0 flex-1 flex-col bg-background text-foreground">
        <AppHeader
          :is-sidebar-open="isSidebarOpen"
          :active-loaded-session="activeLoadedSession"
          :is-active-draft-session="isActiveDraftSession"
          :active-session-id="activeSessionId"
          :is-dark="isDark"
          :is-status-menu-open="isStatusMenuOpen"
          :status="status"
          :is-streaming="isStreaming"
          :status-color="statusColor"
          :status-label="statusLabel"
          :pending-message-count="pendingMessageCount"
          :pending-approval-count="pendingApprovalCount"
          :models-count="models.length"
          @update:is-sidebar-open="isSidebarOpen = $event"
          @update:is-status-menu-open="isStatusMenuOpen = $event"
          @toggle-theme="toggleTheme"
          @clear-queue="clearActiveQueue"
        />

        <div
          class="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-6 sm:px-6"
        >
          <div class="mx-auto flex w-full max-w-3xl flex-col gap-5">
            <UAlert
              v-if="lastError"
              color="error"
              variant="soft"
              title="Backend error"
              :description="lastError"
            />

            <PendingUiRequests
              :requests="activePendingUiRequests"
              @respond="respondToUiRequest"
            />

            <section
              v-if="!hasMessages"
              class="py-10 text-center text-sm text-muted-foreground"
            >
              Empty session. Send a message to start.
            </section>

            <ChatMessage
              v-for="message in activeMessages"
              :key="message.id"
              :message="message"
            />
          </div>
        </div>

        <div class="shrink-0 px-4 pb-4 sm:px-6 sm:pb-6">
          <MessageComposer
            :prompt-text="promptText"
            :is-streaming="isStreaming"
            :is-connected="status === 'connected' && canSubmitToActiveSession"
            :is-draft-session="isActiveDraftSession"
            :model-options="modelOptions"
            :selected-model-key="selectedModelKey"
            :current-thinking-level="currentThinkingLevel"
            :visible-thinking-options="visibleThinkingOptions"
            :pending-model-change="pendingModelChange"
            :pending-thinking-change="pendingThinkingChange"
            @update:prompt-text="promptText = $event"
            @model-select="handleModelSelect"
            @thinking-select="handleThinkingSelect"
            @submit="submitComposer"
          />
        </div>
      </main>
    </div>
  </UApp>
</template>
