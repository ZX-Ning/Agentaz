import type {
    PendingUiRequest,
    ServerHello,
    UiLoadedSession,
    UiMessage,
    UiModel,
    UiSessionSummary,
} from "../../types/protocol";
import {
    type SessionModelState,
    thinkingOptions,
    defaultModelState,
    isDraftSessionId,
    modelKey,
    sessionTitle,
} from "../utils/app.util";
import { buildUnifiedSessions } from "../utils/agentaz-session-list";

/**
 * Creates the reactive state graph shared by every Agentaz controller module.
 *
 * This is the single source of truth that the domain factories
 * (`createAgentazApi`, `createAgentazSessions`, ...) close over. It owns all
 * `ref`s, the mutable nonce counters used for out-of-order request resolution,
 * `ensureModelState`, and every derived `computed`. Splitting these out keeps
 * the workspace component focused on assembly while leaving behaviour
 * untouched: nothing here introduces new reactivity, it only relocates what the
 * page-level controller used to declare inline.
 */
export function useAgentazState() {
    const status = ref<"connecting" | "connected" | "disconnected" | "error">(
        "connecting",
    );
    const hello = ref<ServerHello | null>(null);
    const clientId = ref("");
    const activeSessionId = ref<string | null>(null);
    const loadedSessions = ref<UiLoadedSession[]>([]);
    const persistedSessions = ref<UiSessionSummary[]>([]);
    const messagesBySessionId = ref<Record<string, UiMessage[]>>({});
    const transcriptRevisionBySessionId = ref<Record<string, number>>({});
    const modelStateBySessionId = ref<Record<string, SessionModelState>>({});
    const pendingUiRequestsBySessionId = ref<
        Record<string, PendingUiRequest[]>
    >({});
    const locallyPendingPromptBySessionId = ref<Record<string, boolean>>({});
    const completedTurnFocusRequest = ref<{
        sessionId: string;
        nonce: number;
    } | null>(null);
    const promptText = ref("");
    const lastError = ref<string | null>(null);
    const eventSource = shallowRef<EventSource | null>(null);
    const hasAppliedInitialRoute = ref(false);
    const isSyncingBrowserRoute = ref(false);
    const isUnmounting = ref(false);
    const hasShownDisconnectToast = ref(false);

    // Mutable, non-reactive bookkeeping shared across modules. These were plain
    // closure variables in the original controller; they live on the context so
    // the API and session modules can read/advance the same counters.
    const nonces = {
        completedTurnFocus: 0,
        sessionSwitchRequest: 0,
        latestSessionFocusIntent: null as {
            nonce: number;
            sessionId: string;
        } | null,
    };

    function ensureModelState(sessionId: string) {
        modelStateBySessionId.value[sessionId] ??= defaultModelState();
        return modelStateBySessionId.value[sessionId];
    }

    // --- computed ---

    const activeLoadedSession = computed(
        () =>
            loadedSessions.value.find(
                session => session.sessionId === activeSessionId.value,
            ) ?? null,
    );
    const activeSessionTitle = computed(() => {
        const sessionId = activeSessionId.value;
        if (!sessionId || isDraftSessionId(sessionId)) return "New session";
        const loaded = activeLoadedSession.value;
        if (loaded) return sessionTitle(loaded);
        const persisted = persistedSessions.value.find(
            session => session.sessionId === sessionId,
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
    const isAwaitingActivePromptResponse = computed(() =>
        activeSessionId.value
            ? Boolean(
                  locallyPendingPromptBySessionId.value[activeSessionId.value],
              )
            : false,
    );
    const activeExtensionWidgets = computed(() =>
        activeLoadedSession.value
            ? activeLoadedSession.value.extensionWidgets
            : [],
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
    const isActiveSessionWorking = computed(() =>
        Boolean(
            isAwaitingActivePromptResponse.value ||
            activeLoadedSession.value?.isWorking ||
            activeLoadedSession.value?.isStreaming ||
            (activeLoadedSession.value?.pendingMessageCount ?? 0) > 0,
        ),
    );
    const selectedModelKey = computed(() =>
        currentModel.value ? modelKey(currentModel.value) : "",
    );
    const visibleThinkingOptions = computed(() => {
        const levels =
            availableThinkingLevels.value.length > 0
                ? availableThinkingLevels.value
                : ["off"];
        return thinkingOptions.filter(option => levels.includes(option.value));
    });
    const modelOptions = computed(() =>
        models.value.map((model: UiModel) => ({
            value: modelKey(model),
            label: `${model.name || model.id} - ${model.provider}`,
            description: `${model.provider}/${model.id}`,
            model,
        })),
    );

    return {
        // refs
        status,
        hello,
        clientId,
        activeSessionId,
        loadedSessions,
        persistedSessions,
        messagesBySessionId,
        transcriptRevisionBySessionId,
        modelStateBySessionId,
        pendingUiRequestsBySessionId,
        locallyPendingPromptBySessionId,
        completedTurnFocusRequest,
        promptText,
        lastError,
        eventSource,
        hasAppliedInitialRoute,
        isSyncingBrowserRoute,
        isUnmounting,
        hasShownDisconnectToast,
        nonces,
        // helpers
        ensureModelState,
        // computed
        activeLoadedSession,
        activeSessionTitle,
        isActiveDraftSession,
        activeMessages,
        activeModelState,
        activePendingUiRequests,
        isAwaitingActivePromptResponse,
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
        isActiveSessionWorking,
        selectedModelKey,
        visibleThinkingOptions,
        modelOptions,
    };
}

export type AgentazContext = ReturnType<typeof useAgentazState>;
