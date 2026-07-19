import {
    type AgentSessionEvent,
    type AgentSessionServices,
    type AuthStorage,
    type CompactionEntry,
    type CompactionResult,
    createAgentSessionFromServices,
    type CreateAgentSessionResult,
    type ExtensionUIContext,
    type ModelRegistry,
    type SessionEntry,
    SessionManager,
    type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type {
    ImagePayload,
    ModelStateResponse,
    ServerEvent,
    SessionHistoryResponse,
    ThinkingLevel,
    UiBlock,
    UiMessage,
    UiRuntimeLoadedSession,
    UiSessionUsageStats,
} from "@agentaz/protocol";
import { WebExtensionUIContext } from "../extensions/ui-context.ts";
import {
    ContextCompactUnavailableError,
    UnknownModelError,
} from "../errors.ts";
import { compactUnavailableMessage } from "./sdk-compat.ts";
import { ensurePermissionConfig } from "../extensions/permission-config.ts";
import {
    areSameToolBlock,
    asRecord,
    DEFAULT_THINKING_LEVELS,
    extractToolCallId,
    extractToolInput,
    findToolCallBlock,
    flattenText,
    type HistoryItem,
    normalizeContextUsage,
    normalizeMessages,
    normalizeThinkingLevel,
    type PersistedMessage,
    type PiModel,
    stringOrEmpty,
    stringOrUndefined,
    summarizeSessionManager,
    summarizeToolResult,
    summarizeUsageStatsFromEntries,
    supportedThinkingLevels,
    toPiImages,
    toUiModel,
} from "./session-normalization.ts";

/** Emits a normalized server event to the runtime event bus. */
export type EmitEvent = (event: ServerEvent) => void;

/** Dependencies injected by the workspace that owns a session controller. */
export interface PiSessionControllerHost {
    /** Creates the controller-local Pi SDK services instance. */
    createServices: () => Promise<AgentSessionServices>;
    /** Emits a normalized server event. */
    emit: EmitEvent;
    /** Notifies the workspace that persisted session metadata changed. */
    onSessionMetadataChanged: () => void | Promise<void>;
}

/**
 * Model and thinking-level changes requested while a session is still busy.
 *
 * When the user changes the model or thinking level while the agent is
 * streaming or has pending messages, the change is deferred. It is applied
 * automatically when the session becomes idle (via applyPendingSettingsIfIdle).
 */
type PendingSettings = {
    model?: PiModel;
    thinkingLevel?: ThinkingLevel;
};

/** Compares model identity without relying on SDK object reference stability. */
function modelsMatch(left: PiModel | undefined, right: PiModel) {
    return left?.provider === right.provider && left.id === right.id;
}

type LooseRecord = Record<string, unknown>;

type SessionTranscriptEntry = SessionMessageEntry | CompactionEntry;
type LegacyToolSessionEvent = LooseRecord & {
    type: "tool_start" | "tool_update" | "tool_end";
};
type SessionControllerEvent = AgentSessionEvent | LegacyToolSessionEvent;

/**
 * Runtime location of a tool call block in the canonical transcript projection.
 * Maps a toolCallId to the assistant message it belongs to and the block ids
 * for the tool_call and tool_result blocks within that message.
 */
type ToolBlockLocation = {
    /** The owning assistant message's id. */
    messageId: string;
    /** The UiBlock id for the tool_call entry. */
    callBlockId: string;
    /** The UiBlock id for the tool_result entry. */
    resultBlockId: string;
};

/** Metadata for one browser-submitted prompt turn. */
export type PromptTurn = {
    /** Server-side id for this prompt turn. */
    turnId: string;
    /** Browser-generated id used to reconcile optimistic user messages. */
    clientMessageId: string;
};

/** Public surface of a loaded session controller.
 *  Workspace and test fakes depend on this interface. */
export interface ControllerBase {
    readonly sessionId: string;
    readonly sessionFile: string | undefined;
    historyRevision(): number;
    seedHistoryRevision(revision: number): void;
    isBusy(): boolean;
    rename(name: string): Promise<void>;
    toLoadedSession(): UiRuntimeLoadedSession;
    prompt(
        text: string,
        images: ImagePayload[] | undefined,
        turn: PromptTurn,
    ): Promise<void>;
    steer(text: string, images?: ImagePayload[]): Promise<void>;
    followUp(text: string, images?: ImagePayload[]): Promise<void>;
    abort(): Promise<void>;
    clearQueue(): Promise<void>;
    compact(
        customInstructions?: string,
    ): Promise<CompactionResult & { revision: number }>;
    getModelState(): ModelStateResponse;
    setModel(provider: string, id: string): Promise<ModelStateResponse>;
    setThinkingLevel(level: ThinkingLevel): Promise<ModelStateResponse>;
    resolveSelect(requestId: string, selected?: string): void;
    resolveInput(requestId: string, value?: string): void;
    resolveConfirm(requestId: string, confirmed: boolean): void;
    dispose(): Promise<void>;
    getHistory(): SessionHistoryResponse;
    getEntries(): SessionEntry[];
    getSessionManager(): SessionManager;
}

/**
 * Per-loaded-session controller; not a singleton.
 * Owns one Pi SDK session, isolated services, transcript projection, queues,
 * model/thinking state, and extension UI bridge until workspace disposal.
 * Realtime detach does not stop the session; explicit abort/dispose does.
 */
export class PiSessionController implements ControllerBase {
    /** The result of createAgentSessionFromServices — holds the live Pi session. */
    private sessionResult?: CreateAgentSessionResult;
    /**
     * Controller-local Pi SDK AgentSessionServices cache.
     *
     * Each controller owns its own services instance (resource loader, extension
     * runtime). Cached per-controller so concurrent calls to ensureInitialized
     * on the same controller share one initialization.
     */
    private servicesPromise?: Promise<AgentSessionServices>;
    /**
     * The SessionManager backing this controller.
     * Created fresh for new sessions; opened from a file path for existing sessions.
     */
    private sessionManager?: SessionManager;
    /** Promise that resolves when the Pi SDK session is fully initialized. */
    private initPromise?: Promise<void>;
    /** Cleanup function returned by session.subscribe(). */
    private unsubscribe?: () => void;
    /** Browser-backed extension UI context (prompts, widgets, notifications). */
    private uiContext?: WebExtensionUIContext;
    /** Whether this controller is currently being disposed. */
    private disposing = false;
    /** Whether this controller has finished disposal and must not be reused. */
    private disposed = false;
    /** Whether manual context compaction is currently mutating this session. */
    private compacting = false;
    /** Deferred model/thinking changes waiting for the session to become idle. */
    private pendingSettings: PendingSettings = {};

    // ── Transcript projection state ──────────────────────────────────────
    /** The current assistant message being built from streaming deltas. */
    private currentAssistantMessageId: string = crypto.randomUUID();
    /** Tracked text block id within the current assistant message. */
    private currentTextBlockId?: string;
    /** Tracked thinking block id within the current assistant message. */
    private currentThinkingBlockId?: string;
    /** Mutable browser projection for the active agent turn; cleared at agent_end. */
    private liveTurnMessages = new Map<string, UiMessage>();
    /** Maps tool call ids to their location in the active live projection. */
    private toolBlocks = new Map<string, ToolBlockLocation>();
    /** Last active tool location used to anchor extension UI prompts. */
    private currentToolRequestAnchor?: {
        messageId: string;
        toolCallId: string;
    };
    /** Synthetic id for anonymous tool calls that lack explicit toolCallId fields. */
    private anonymousToolCallId?: string;
    /** Anonymous events are ignored after overlapping starts lose correlation. */
    private anonymousToolProjectionAmbiguous = false;
    /** Counter for generating unique anonymous tool call ids. */
    private anonymousToolCallCounter = 0;
    /**
     * Tracks the last emitted length of streaming tool result content per tool call.
     *
     * Keyed by toolCallId. When a tool emits incremental output via tool_execution_update,
     * the full accumulated text from partialResult.content is compared against the last
     * emitted length to compute a delta. Cleaned up on tool_execution_end and agent_end.
     */
    private toolResultEmittedLength = new Map<string, number>();
    /** Cached normalized history; invalidated when messages change. */
    private cachedHistory?: SessionHistoryResponse;
    /** Cumulative branch usage cached by the manager's current leaf id. */
    private cachedUsageStats?: {
        leafId: string | null;
        value: UiSessionUsageStats;
    };
    /** Monotonic counter for normalized transcript/history changes. */
    private transcriptRevision = 0;

    constructor(
        private readonly cwd: string,
        private readonly agentDir: string,
        private readonly authStorage: ReturnType<typeof AuthStorage.create>,
        private readonly modelRegistry: ReturnType<typeof ModelRegistry.create>,
        private readonly approvalTimeoutMs: number,
        private readonly host: PiSessionControllerHost,
    ) {}

    /**
     * Returns (and lazily creates) this controller's own AgentSessionServices.
     *
     * The promise is cached per-controller so concurrent calls to
     * ensureInitialized share one service initialization. On failure,
     * the cached promise is reset so the next call can retry.
     */
    private getServices(): Promise<AgentSessionServices> {
        if (this.servicesPromise) {
            return this.servicesPromise;
        }
        this.servicesPromise = this.host.createServices().catch((error) => {
            this.servicesPromise = undefined;
            throw error;
        });
        return this.servicesPromise;
    }

    /** Returns the live Pi SDK session owned by this controller. */
    get session() {
        return this.sessionResult?.session;
    }

    /**
     * Stable Pi session identifier used for protocol routing.
     * Falls back to the SessionManager's id if the SDK session isn't initialized yet.
     */
    get sessionId() {
        return (
            this.session?.sessionId ??
                this.requireSessionManager().getSessionId()
        );
    }

    /**
     * Current session file path for persisted sessions.
     * Falls back to the SessionManager's file path before initialization.
     */
    get sessionFile() {
        return (
            this.session?.sessionFile ??
                this.requireSessionManager().getSessionFile()
        );
    }

    /** Returns the current normalized transcript/history freshness token. */
    historyRevision() {
        return this.transcriptRevision;
    }

    /**
     * Raises this controller's history revision after workspace-level reloads.
     * Revert reopens the same session file under the same session id, so the
     * frontend needs the new controller's revision to stay above stale responses
     * produced by the previous controller instance.
     */
    seedHistoryRevision(revision: number) {
        if (revision <= this.transcriptRevision) {
            return;
        }
        this.transcriptRevision = revision;
        this.cachedHistory = undefined;
        this.cachedUsageStats = undefined;
    }

    /**
     * Returns whether the session must remain loaded because work is still in flight.
     * A session is busy if:
     *   - It's still initializing (initPromise is pending).
     *   - The agent workflow is active (streaming or has queued messages).
     *   - There are outstanding browser-backed UI prompts waiting for user input.
     */
    isBusy() {
        return (
            Boolean(this.initPromise) ||
            this.compacting ||
            this.isWorkflowBusy() ||
            (this.uiContext?.pendingCount ?? 0) > 0
        );
    }

    /**
     * Appends user-facing session metadata to the backing session file.
     *
     * Pi sessions are append-only, so renaming is represented as a session_info
     * entry rather than an in-place header update. getSessionName() resolves the
     * latest session_info entry when projecting sidebar summaries.
     */
    async rename(name: string) {
        this.requireSessionManager().appendSessionInfo(name);
        await this.host.onSessionMetadataChanged();
    }

    /**
     * Converts this loaded session into a browser sidebar/status row.
     * Includes runtime state (isWorking, isStreaming, pending counts)
     * and extension widget projections.
     */
    toLoadedSession(): UiRuntimeLoadedSession {
        const session = this.session;
        const sessionId = this.sessionId;
        const sessionFile = this.sessionFile;
        const summary = summarizeSessionManager(
            this.requireSessionManager(),
        );
        return {
            file: sessionFile ?? sessionId,
            ...summary,
            sessionId,
            sessionFile,
            isWorking: this.isBusy(),
            isStreaming: session?.isStreaming ?? false,
            pendingMessageCount: session?.pendingMessageCount ?? 0,
            pendingApprovalCount: this.uiContext?.pendingCount ?? 0,
            pendingUiRequests: this.uiContext?.pendingRequests ?? [],
            extensionWidgets: this.uiContext?.extensionWidgets ?? [],
            contextUsage: this.contextUsage(),
            usageStats: this.usageStats(),
        };
    }

    /**
     * Sends a prompt to this session and waits for the Pi agent loop to finish.
     * This is the primary message entry point — starts a new agent turn.
     */
    async prompt(
        text: string,
        images: ImagePayload[] | undefined,
        turn: PromptTurn,
    ) {
        await this.ensureInitialized();
        this.startPromptTurn(text, turn);
        try {
            await this.requireSession().prompt(text, {
                images: toPiImages(images),
            });
            this.host.emit({
                type: "turn_completed",
                sessionId: this.sessionId,
                turnId: turn.turnId,
                transcriptRevision: this.transcriptRevision,
            });
        }
        catch (error) {
            const message = error instanceof Error
                ? error.message
                : String(error);
            this.host.emit({
                type: "turn_failed",
                sessionId: this.sessionId,
                turnId: turn.turnId,
                clientMessageId: turn.clientMessageId,
                message,
                transcriptRevision: this.transcriptRevision,
            });
            throw error;
        }
        finally {
            this.invalidateUsageStatsCache();
        }
    }

    /**
     * Sends steering text to the currently streaming session.
     * Steer messages redirect the agent's current output without starting a new turn.
     */
    async steer(text: string, images?: ImagePayload[]) {
        await this.ensureInitialized();
        await this.requireSession().prompt(text, {
            images: toPiImages(images),
            streamingBehavior: "steer",
        });
    }

    /**
     * Queues a follow-up prompt for the currently streaming session.
     * Follow-up messages are processed after the current agent turn completes.
     */
    async followUp(text: string, images?: ImagePayload[]) {
        await this.ensureInitialized();
        await this.requireSession().prompt(text, {
            images: toPiImages(images),
            streamingBehavior: "followUp",
        });
    }

    /**
     * Aborts the active agent operation and cancels all pending browser-backed
     * extension UI prompts. The session remains loaded after abort — only the
     * in-flight workflow is terminated.
     */
    async abort() {
        await this.ensureInitialized();
        this.uiContext?.cancelAll();
        await this.requireSession().abort();
        this.sendStatus();
    }

    /**
     * Clears queued steering and follow-up messages.
     * Emits a queue_update event with empty arrays and sends an updated status.
     */
    async clearQueue() {
        await this.ensureInitialized();
        const cleared = this.requireSession().clearQueue();
        this.host.emit({
            type: "queue_update",
            sessionId: this.sessionId,
            steering: [],
            followUp: [],
        });
        this.sendStatus();
        console.log("[agentaz-server] cleared queue", cleared);
    }

    /**
     * Manually compacts the active session context through the Pi SDK.
     *
     * Workspace code rejects busy sessions before calling this method, so the
     * SDK's internal abort step should be a no-op for browser-triggered compact.
     */
    async compact(customInstructions?: string) {
        this.compacting = true;
        try {
            await this.ensureInitialized();
            const result = await this.requireSession().compact(
                customInstructions,
            );
            this.invalidateUsageStatsCache();
            this.invalidateHistoryCache();
            return {
                ...result,
                revision: this.transcriptRevision,
            } satisfies CompactionResult & { revision: number };
        }
        catch (error) {
            const message = compactUnavailableMessage(error);
            if (message) {
                throw new ContextCompactUnavailableError(message);
            }
            throw error;
        }
        finally {
            this.compacting = false;
            this.sendStatus();
        }
    }

    /**
     * Returns the model list and current/target model state for this session.
     *
     * Handles three scenarios:
     *   1. Session is initialized — reads model from the live Pi session.
     *   2. Session is not yet initialized — restores model from the SessionManager's
     *      persisted session context (buildSessionContext).
     *   3. A pending model/thinking change exists — included in the response so
     *      the frontend can show a "pending" badge.
     */
    getModelState(): ModelStateResponse {
        const session = this.session;

        // If the session isn't initialized yet, try to restore the model
        // from the persisted session context on disk.
        const restored = session
            ? undefined
            : this.buildDormantSessionContext();
        const restoredModel = restored?.model
            ? this.modelRegistry.find(
                restored.model.provider,
                restored.model.modelId,
            )
            : undefined;

        return {
            sessionId: this.sessionId,
            models: this.modelRegistry.getAvailable().map(toUiModel),
            current: session?.model
                ? toUiModel(session.model)
                : restoredModel
                ? toUiModel(restoredModel)
                : undefined,
            thinkingLevel: session?.thinkingLevel ??
                normalizeThinkingLevel(restored?.thinkingLevel),
            availableThinkingLevels: session?.getAvailableThinkingLevels() ??
                (restoredModel
                    ? supportedThinkingLevels(restoredModel)
                    : DEFAULT_THINKING_LEVELS),
            pendingModel: this.pendingSettings.model
                ? toUiModel(this.pendingSettings.model)
                : undefined,
            pendingThinkingLevel: this.pendingSettings.thinkingLevel,
        };
    }

    /** Wraps persisted-context corruption with session detail for the HTTP error log. */
    private buildDormantSessionContext() {
        try {
            return this.requireSessionManager().buildSessionContext();
        }
        catch (cause) {
            // Do not log here: the request boundary logs this contextual error once.
            throw new Error(
                `Failed to build persisted model context for session ${this.sessionId}.`,
                { cause },
            );
        }
    }

    /**
     * Sets the model immediately or queues it until the session is idle.
     *
     * If the agent is currently streaming or has pending messages, the model
     * change is stored in pendingSettings and applied automatically when the
     * session becomes idle (via the queue_update or agent_end event handler).
     */
    async setModel(provider: string, id: string) {
        await this.ensureInitialized();
        const model = this.modelRegistry.find(provider, id);
        if (!model) {
            throw new UnknownModelError(provider, id);
        }

        const session = this.requireSession();
        if (this.isWorkflowBusy()) {
            // Defer: the model change will be applied when the session becomes idle.
            this.pendingSettings.model = model;
            return this.getModelState();
        }

        await session.setModel(model);
        return this.getModelState();
    }

    /**
     * Sets the thinking level immediately or queues it until the session is idle.
     * Same deferred-apply pattern as setModel.
     */
    async setThinkingLevel(level: ThinkingLevel) {
        await this.ensureInitialized();
        const session = this.requireSession();
        if (this.isWorkflowBusy()) {
            this.pendingSettings.thinkingLevel = level;
            return this.getModelState();
        }

        session.setThinkingLevel(level);
        return this.getModelState();
    }

    /** Resolves a browser-backed select prompt for this session. */
    resolveSelect(requestId: string, selected?: string) {
        this.uiContext?.resolveSelect(requestId, selected);
        this.sendStatus();
    }

    /** Resolves a browser-backed input prompt for this session. */
    resolveInput(requestId: string, value?: string) {
        this.uiContext?.resolveInput(requestId, value);
        this.sendStatus();
    }

    /** Resolves a browser-backed confirmation prompt for this session. */
    resolveConfirm(requestId: string, confirmed: boolean) {
        this.uiContext?.resolveConfirm(requestId, confirmed);
        this.sendStatus();
    }

    /**
     * Releases subscriptions, cancels pending prompts, emits extension
     * session_shutdown, and disposes the underlying SDK session.
     *
     * Extension shutdown is emitted before SDK disposal so permission-system
     * (and any other extension with a polling interval) can stop its timers
     * before the extension context becomes stale.
     *
     * dispose() is idempotent: a second call after cleanup is a no-op.
     * After disposal, the controller should not be used.
     */
    async dispose() {
        if (this.disposed || this.disposing) {
            return;
        }
        this.disposing = true;

        // Snapshot the SDK session directly. requireSession(false) rejects
        // disposing controllers, but dispose itself still needs to tear down
        // the current session if one exists.
        const session = this.session;

        try {
            // Phase 1: Cancel browser-backed UI prompts and unsubscribe from
            // session events so no further event processing occurs.
            this.uiContext?.cancelAll();
            this.unsubscribe?.();
            this.unsubscribe = undefined;

            // Phase 2: Emit extension session_shutdown before SDK disposal.
            // This lets extensions (especially @gotgenes/pi-permission-system)
            // clean up their polling intervals before the extension context
            // becomes stale.
            if (session) {
                try {
                    await session.extensionRunner.emit({
                        type: "session_shutdown",
                        reason: "quit",
                    });
                }
                catch (error) {
                    console.error(
                        "[agentaz-server] extension session_shutdown error",
                        error,
                    );
                }
            }

            // Phase 3: Dispose the SDK session. This invalidates the extension
            // runner and releases SDK resources.
            session?.dispose();
        }
        finally {
            this.sessionResult = undefined;
            this.uiContext = undefined;
            this.unsubscribe = undefined;
            this.servicesPromise = undefined;
            this.disposed = true;
            this.disposing = false;
        }
    }

    /**
     * Returns normalized chat history for HTTP consumption.
     *
     * The result is cached until the transcript changes. Cache invalidation
     * happens in onSessionEvent whenever a message_update, tool_* event, or
     * agent_end event is received.
     */
    getHistory(): SessionHistoryResponse {
        if (this.cachedHistory) {
            return this.cachedHistory;
        }
        const branchEntries = this.requireSessionManager()
            .getBranch()
            .filter((entry): entry is SessionEntry => Boolean(entry.id));
        const entryIdByMessageId = new Map<string, string>();
        const entryIdByMessageIndex = new Map<number, string>();
        const rewindEntryIdByMessageId = new Map<string, string>();
        const rewindEntryIdByMessageIndex = new Map<number, string>();
        const transcriptEntries = branchEntries.filter(
            (entry): entry is SessionTranscriptEntry =>
                entry.type === "message" || entry.type === "compaction",
        );
        const branchIndexByEntryId = new Map(
            branchEntries.map((entry, index) => [entry.id, index]),
        );

        const historyItems = transcriptEntries.map(
            (entry, index): HistoryItem => {
                if (entry.type === "compaction") {
                    return entry;
                }

                const message = asRecord(entry.message) as PersistedMessage;
                const branchIndex = branchIndexByEntryId.get(entry.id) ?? -1;
                const rewindEntryId = branchEntries[branchIndex - 1]?.id;
                if (message?.id) {
                    entryIdByMessageId.set(String(message.id), entry.id);
                }
                if (message?.id && rewindEntryId) {
                    rewindEntryIdByMessageId.set(
                        String(message.id),
                        rewindEntryId,
                    );
                }
                entryIdByMessageIndex.set(index, entry.id);
                if (rewindEntryId) {
                    rewindEntryIdByMessageIndex.set(index, rewindEntryId);
                }
                return message;
            },
        );

        this.cachedHistory = {
            sessionId: this.sessionId,
            revision: this.transcriptRevision,
            messages: normalizeMessages(historyItems, {
                entryIdByMessageId,
                entryIdByMessageIndex,
                rewindEntryIdByMessageId,
                rewindEntryIdByMessageIndex,
            }),
        };
        return this.cachedHistory;
    }

    /**
     * Returns the entries on the current root-to-leaf branch.
     *
     * This intentionally does not expose the full append-only tree. The browser's
     * first fork/revert picker is a linear current-history picker, so abandoned
     * branches stay server-side until there is an explicit tree UI.
     */
    getEntries(): SessionEntry[] {
        return this.requireSessionManager().getBranch();
    }

    /**
     * Returns the backing SessionManager for workspace-owned session operations.
     *
     * Callers must not invoke mutating branch/fork methods casually. In
     * particular, createBranchedSession() mutates the manager instance; fork code
     * should use a temporary SessionManager opened from the source file instead.
     */
    getSessionManager() {
        return this.requireSessionManager();
    }

    /** Invalidates the cached history when session messages change. */
    private invalidateHistoryCache() {
        this.cachedHistory = undefined;
        this.transcriptRevision += 1;
    }

    /**
     * Records and broadcasts the canonical user message for a prompt turn.
     *
     * Pi persists the user message inside session.prompt(), but that persistence
     * is not exposed as a dedicated realtime event. Emitting this explicit turn
     * start gives the browser a server-confirmed message id before assistant
     * streaming begins, so optimistic local messages never depend on history
     * refresh timing.
     */
    private startPromptTurn(text: string, turn: PromptTurn) {
        const messageId = `user-${turn.clientMessageId}`;
        const userMessage: UiMessage = {
            id: messageId,
            clientMessageId: turn.clientMessageId,
            turnId: turn.turnId,
            role: "user",
            blocks: [{ id: `${messageId}:text`, type: "text", text }],
            createdAt: Date.now(),
        };
        this.invalidateHistoryCache();
        this.host.emit({
            type: "turn_started",
            sessionId: this.sessionId,
            turnId: turn.turnId,
            clientMessageId: turn.clientMessageId,
            userMessage,
        });
    }

    /** Attaches the persistence manager without creating the live Pi SDK session. */
    attachSessionManager(sessionManager: SessionManager) {
        this.sessionManager = sessionManager;
    }

    /**
     * Ensures the Pi SDK session is initialized exactly once.
     *
     * Uses a dedup pattern: if multiple callers call ensureInitialized
     * concurrently, only one initialization runs and the others wait on
     * the shared initPromise.
     */
    private async ensureInitialized() {
        if (this.sessionResult) {
            return;
        }
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = this.initializeSession();
        try {
            await this.initPromise;
        }
        finally {
            this.initPromise = undefined;
        }
    }

    /**
     * Full session initialization: creates the Pi SDK session, binds extensions,
     * and subscribes to session events for streaming transcript projection.
     *
     * If any step after session creation fails (bindExtensions, subscribe), the
     * partially initialized session is cleaned up: session_shutdown is emitted
     * so extensions stop their timers, the session is disposed, and controller
     * references are cleared so the controller can retry initialization later.
     */
    private async initializeSession() {
        // Ensure the permission-system config exists in the agent directory.
        // This is idempotent — if the config already exists, it's a no-op.
        await ensurePermissionConfig(this.agentDir);

        // Create the Pi SDK session from this controller's own services and
        // its SessionManager. Each controller gets isolated extension runtime.
        const services = await this.getServices();
        this.sessionResult = await createAgentSessionFromServices({
            services,
            sessionManager: this.requireSessionManager(),
        });

        const session = this.requireSession();

        // Create the WebExtensionUIContext that bridges Pi extension prompts
        // (select, input, confirm) to realtime browser events.
        this.uiContext = new WebExtensionUIContext(
            session.sessionId,
            this.host.emit,
            this.approvalTimeoutMs,
            () => this.currentToolRequestAnchor,
            () => this.sendStatus(),
        );

        try {
            // Bind extensions with the browser-backed UI context and an error handler.
            await session.bindExtensions({
                uiContext: this.uiContext as ExtensionUIContext,
                onError: (error) => {
                    console.error("[agentaz-server] extension error", error);
                    this.host.emit({
                        type: "error",
                        code: "extension_error",
                        message: error instanceof Error
                            ? error.message
                            : String(error),
                        recoverable: true,
                    });
                },
            });

            // Subscribe to all session events for transcript streaming.
            // The unsubscribe function is stored for cleanup on dispose.
            this.unsubscribe = session.subscribe((event) => {
                this.onSessionEvent(event);
            });
        }
        catch (error) {
            // If bindExtensions or subscribe fails after extensions were partially
            // initialized, emit session_shutdown so any started extension timers
            // (e.g. permission-system ForwardingManager) are stopped, then dispose
            // the partial session and clear controller references.
            try {
                await session.extensionRunner.emit({
                    type: "session_shutdown",
                    reason: "quit",
                });
            }
            catch (shutdownError) {
                console.error(
                    "[agentaz-server] extension session_shutdown error during init cleanup",
                    shutdownError,
                );
            }

            session.dispose();
            this.sessionResult = undefined;
            this.uiContext = undefined;
            this.unsubscribe = undefined;
            this.servicesPromise = undefined;
            throw error;
        }
    }

    /**
     * Applies any pending model/thinking level changes if the session
     * is now idle. Called from the queue_update and agent_end event handlers.
     */
    private async applyPendingSettingsIfIdle() {
        const session = this.session;
        if (!session || this.isWorkflowBusy()) {
            return;
        }

        // Snapshot and clear pending settings before applying, so the
        // getModelState() call in setModel/setThinkingLevel doesn't
        // re-read the stale pending values.
        const { model, thinkingLevel } = this.pendingSettings;
        this.pendingSettings = {};

        if (model) {
            try {
                await session.setModel(model);
            }
            catch (error) {
                // setModel can fail before mutation (e.g. missing auth) or after
                // mutation (e.g. an extension hook). Retry only when the target
                // was not applied, and never overwrite a newer pending request.
                if (
                    !modelsMatch(session.model, model) &&
                    !this.pendingSettings.model
                ) {
                    this.pendingSettings.model = model;
                }
                this.emitPendingSettingsError("model", error);
            }
        }
        if (thinkingLevel) {
            try {
                session.setThinkingLevel(thinkingLevel);
            }
            catch (error) {
                if (
                    session.thinkingLevel !== thinkingLevel &&
                    !this.pendingSettings.thinkingLevel
                ) {
                    this.pendingSettings.thinkingLevel = thinkingLevel;
                }
                this.emitPendingSettingsError("thinking level", error);
            }
        }
    }

    /** Reports a deferred setting failure without rejecting the event callback. */
    private emitPendingSettingsError(setting: string, error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(
            `[agentaz-server] failed to apply pending ${setting}`,
            error,
        );
        this.host.emit({
            type: "error",
            code: "settings_apply_failed",
            message: `Failed to apply pending ${setting}: ${detail}`,
            recoverable: true,
        });
    }

    /**
     * Central event dispatcher for all Pi SDK session events.
     *
     * Routes each event type to the appropriate handler:
     *   - message_start: Assistant API call started; reset text/thinking block
     *     anchors while keeping the browser-visible assistant turn intact.
     *   - message_update: Text deltas from the agent (streaming response text).
     *   - tool_execution_start / tool_start: Tool call started (status=pending).
     *   - tool_execution_update / tool_update: Tool call in progress (status=running).
     *   - tool_execution_end / tool_end: Tool call completed or errored.
     *   - queue_update: Steer/follow-up queue changed; apply pending settings.
     *   - compaction_end: Pi wrote a compaction entry; refresh usage/history.
     *   - agent_end: Agent turn completed; flush the current assistant message.
     *   - thinking_level_changed: Update the frontend status.
     *   - session_info_changed: Notify the workspace to refresh persisted metadata.
     */
    private onSessionEvent(event: SessionControllerEvent) {
        try {
            const sessionId = this.sessionId;
            switch (event.type) {
                case "message_start":
                    // A single browser-visible assistant turn can contain multiple Pi SDK
                    // assistant messages, for example: text -> tool -> text. Keep the
                    // same UiMessage for the turn, but force the next text/thinking delta
                    // to create a fresh block after any intervening tool blocks.
                    if (event.message?.role === "assistant") {
                        this.currentTextBlockId = undefined;
                        this.currentThinkingBlockId = undefined;
                    }
                    break;
                case "message_update":
                    this.forwardMessageUpdate(sessionId, event);
                    this.invalidateHistoryCache();
                    break;
                // Handle both Pi SDK event shapes: camelCase and snake_case.
                case "tool_execution_start":
                case "tool_start":
                    this.upsertToolCallBlock(sessionId, event, "pending");
                    this.invalidateHistoryCache();
                    break;
                case "tool_execution_update":
                case "tool_update":
                    this.upsertToolCallBlock(sessionId, event, "running");
                    this.streamToolResultDelta(sessionId, event);
                    this.invalidateHistoryCache();
                    break;
                case "tool_execution_end":
                case "tool_end":
                    this.completeToolCallBlock(sessionId, event);
                    this.invalidateHistoryCache();
                    break;
                case "queue_update":
                    // Forward queue contents to the browser for the queue panel.
                    this.host.emit({
                        type: "queue_update",
                        sessionId,
                        steering: [...event.steering],
                        followUp: [...event.followUp],
                    });
                    this.sendStatus();
                    // Apply any deferred model/thinking changes now that the
                    // session may have become idle (queue drained).
                    void this.applyPendingSettingsIfIdle();
                    break;
                case "compaction_end":
                    this.invalidateUsageStatsCache();
                    this.invalidateHistoryCache();
                    this.sendStatus();
                    break;
                case "agent_end":
                    this.invalidateUsageStatsCache();
                    this.sendStatus();
                    // Flush the final state of the current assistant message.
                    this.flushCurrentAssistantMessage(sessionId);
                    // Persisted history is authoritative after turn_completed;
                    // retain no completed live projection in this controller.
                    this.liveTurnMessages.clear();
                    // Reset live-turn state for the next agent turn.
                    this.currentAssistantMessageId = crypto.randomUUID();
                    this.currentTextBlockId = undefined;
                    this.currentThinkingBlockId = undefined;
                    this.toolBlocks.clear();
                    this.toolResultEmittedLength.clear();
                    this.currentToolRequestAnchor = undefined;
                    this.anonymousToolCallId = undefined;
                    this.anonymousToolProjectionAmbiguous = false;
                    void this.applyPendingSettingsIfIdle();
                    this.invalidateHistoryCache();
                    break;
                case "thinking_level_changed":
                    this.sendStatus();
                    break;
                case "session_info_changed":
                    void this.notifySessionMetadataChanged();
                    break;
            }
        }
        catch (error) {
            console.error(
                "[agentaz-server] failed to forward session event",
                error,
            );
        }
    }

    /** Notifies the workspace that session metadata changed (name, first message, etc.). */
    private async notifySessionMetadataChanged() {
        try {
            await this.host.onSessionMetadataChanged();
        }
        catch (error) {
            console.error(
                "[agentaz-server] failed to refresh session metadata",
                error,
            );
        }
    }

    /**
     * Forwards text and thinking deltas from a message_update event.
     *
     * Pi SDK events use different shapes depending on the provider. We
     * normalize by checking for assistantMessageEvent first (newer shape),
     * then fall back to messageEvent for backward compatibility.
     */
    private forwardMessageUpdate(sessionId: string, event: unknown) {
        const eventRecord = asRecord(event);
        const messageEvent = asRecord(
            eventRecord.assistantMessageEvent ?? eventRecord.messageEvent ??
                event,
        );

        // Text delta: append to the current text block in the transcript.
        if (messageEvent.type === "text_delta") {
            this.appendAssistantBlockDelta(
                sessionId,
                stringOrUndefined(eventRecord.messageId),
                "text",
                stringOrEmpty(messageEvent.delta),
            );
        }

        // Thinking delta: append to the current thinking block (initially collapsed).
        if (messageEvent.type === "thinking_delta") {
            this.appendAssistantBlockDelta(
                sessionId,
                stringOrUndefined(eventRecord.messageId),
                "thinking",
                stringOrEmpty(messageEvent.delta),
            );
        }
    }

    /**
     * Appends a delta to an assistant message block and emits a message_block_delta
     * event for realtime streaming display in the browser.
     */
    private appendAssistantBlockDelta(
        sessionId: string,
        messageId: string | undefined,
        blockType: "text" | "thinking",
        delta: string,
    ) {
        const message = this.ensureAssistantMessage(sessionId, messageId);
        const block = blockType === "text"
            ? this.ensureTextBlock(sessionId, message)
            : this.ensureThinkingBlock(sessionId, message);

        // Accumulate the delta text in the block.
        block.text += delta;

        // Emit the delta for realtime streaming display.
        this.host.emit({
            type: "message_block_delta",
            sessionId,
            messageId: message.id,
            blockId: block.id,
            blockType,
            delta,
        });
    }

    /**
     * Creates or updates a tool_call block in the transcript.
     *
     * Handles tool call lifecycle:
     *   1. "pending" (tool_start): Create a new block with extracted input.
     *   2. "running" (tool_update): Update the block's status to running.
     *   3. The block is later completed by completeToolCallBlock.
     */
    private upsertToolCallBlock(
        sessionId: string,
        event: unknown,
        status: Extract<UiBlock, { type: "tool_call" }>["status"],
    ) {
        const eventRecord = asRecord(event);
        // Determine the tool call id. Events from different providers use
        // different shapes — toolCallId handles extraction from known fields.
        const toolCallId = this.toolCallId(
            event,
            status === "pending" ? "start" : "update",
        );
        if (!toolCallId) {
            return;
        }

        // Ensure we have a location mapping for this tool call.
        const location = this.ensureToolBlockLocation(sessionId, toolCallId);
        this.currentToolRequestAnchor = {
            messageId: location.messageId,
            toolCallId,
        };
        const message = this.ensureAssistantMessage(
            sessionId,
            location.messageId,
        );

        // Try to find an existing tool_call block — either by toolCallId
        // or by the callBlockId from our location mapping.
        const existing = findToolCallBlock(message, toolCallId) ??
            message.blocks.find(
                (block): block is Extract<UiBlock, { type: "tool_call" }> =>
                    block.id === location.callBlockId &&
                    block.type === "tool_call",
            );

        // Build the block, merging existing data for fields that aren't in every event.
        const block: UiBlock = {
            id: location.callBlockId,
            type: "tool_call",
            toolCallId,
            toolName: stringOrUndefined(eventRecord.toolName) ??
                stringOrUndefined(eventRecord.name) ??
                stringOrUndefined(eventRecord.tool) ??
                existing?.toolName ??
                "tool",
            input: extractToolInput(event) ?? existing?.input,
            status,
        };

        this.upsertBlock(message, block);
        this.host.emit({
            type: "message_block_upsert",
            sessionId,
            messageId: message.id,
            block,
        });
    }

    /**
     * Streams incremental tool result content from tool_execution_update events.
     *
     * The Pi SDK bash tool emits accumulated partial output via the onUpdate callback,
     * which arrives here as event.partialResult. This method:
     *
     *   1. Extracts the full accumulated text from partialResult.content.
     *   2. On the first update for a tool call, creates an empty tool_result block
     *      via message_block_upsert (to anchor the block id on the frontend).
     *   3. On every update, computes the delta (new text since last emission) and
     *      sends it via message_block_delta with blockType "tool_result".
     *
     * The streaming content is ephemeral — completeToolCallBlock replaces it with
     * the final truncated (500-char) result via a message_block_upsert replacement.
     *
     * Tools that do not emit partial results (read, write, edit, etc.) never reach
     * this method, so their behavior is unchanged.
     */
    private streamToolResultDelta(sessionId: string, event: unknown) {
        const partialResult = asRecord(event).partialResult;
        if (!partialResult) {
            return;
        }

        const toolCallId = this.toolCallId(event, "update");
        if (!toolCallId) {
            return;
        }
        const location = this.ensureToolBlockLocation(sessionId, toolCallId);
        const fullText = flattenText(asRecord(partialResult).content ?? []);

        const emitted = this.toolResultEmittedLength.get(toolCallId);

        // First update for this tool call: create an empty result block to anchor
        // the block id on the frontend so subsequent deltas have a target.
        if (emitted === undefined) {
            const message = this.ensureAssistantMessage(
                sessionId,
                location.messageId,
            );
            const block: UiBlock = {
                id: location.resultBlockId,
                type: "tool_result",
                toolCallId,
                content: "",
                isError: false,
            };
            this.upsertBlock(message, block);
            this.host.emit({
                type: "message_block_upsert",
                sessionId,
                messageId: message.id,
                block,
            });
            this.toolResultEmittedLength.set(toolCallId, 0);
        }

        const delta = fullText.slice(
            this.toolResultEmittedLength.get(toolCallId)!,
        );
        if (delta.length > 0) {
            this.host.emit({
                type: "message_block_delta",
                sessionId,
                messageId: location.messageId,
                blockId: location.resultBlockId,
                blockType: "tool_result",
                delta,
            });
            this.toolResultEmittedLength.set(toolCallId, fullText.length);
        }
    }

    /**
     * Completes a tool call by setting its final status and adding a tool_result block.
     *
     * Steps:
     *   1. Update the tool_call block to "completed" or "error" status.
     *   2. Create a tool_result block with summarized output.
     *   3. Clean up anonymous tool call tracking if needed.
     */
    private completeToolCallBlock(sessionId: string, event: unknown) {
        const eventRecord = asRecord(event);
        const isError = Boolean(eventRecord.isError ?? eventRecord.error);

        // Update the tool_call block to its final status.
        this.upsertToolCallBlock(
            sessionId,
            event,
            isError ? "error" : "completed",
        );

        // Create the result block with summarized content.
        const toolCallId = this.toolCallId(event, "end");
        if (!toolCallId) {
            return;
        }
        const location = this.ensureToolBlockLocation(sessionId, toolCallId);
        const message = this.ensureAssistantMessage(
            sessionId,
            location.messageId,
        );

        // Truncate long results to 500 chars for browser display.
        // Extract .content from AgentToolResult objects (same shape as partialResult)
        // so that flattenText sees the text array rather than the wrapper object.
        const rawResult = eventRecord.result ?? eventRecord.output ??
            eventRecord.error;
        const summary = summarizeToolResult(
            asRecord(rawResult).content ?? rawResult,
        );

        const resultBlock: UiBlock = {
            id: location.resultBlockId,
            type: "tool_result",
            toolCallId,
            content: summary,
            isError,
        };

        this.upsertBlock(message, resultBlock);
        this.host.emit({
            type: "message_block_upsert",
            sessionId,
            messageId: message.id,
            block: resultBlock,
        });

        // Clean up streaming result tracking.
        this.toolResultEmittedLength.delete(toolCallId);

        // Clean up anonymous tool call tracking when this tool completes.
        if (
            !extractToolCallId(event) &&
            this.anonymousToolCallId === toolCallId
        ) {
            this.anonymousToolCallId = undefined;
        }
    }

    /**
     * Returns (or creates) an assistant message in the transcript.
     *
     * If the message doesn't exist yet, creates it with role "assistant",
     * registers it in the transcript map, and emits a message_upsert event
     * so the browser sees the new message immediately.
     */
    private ensureAssistantMessage(
        sessionId: string,
        messageId = this.currentAssistantMessageId,
    ) {
        let message = this.liveTurnMessages.get(messageId);
        if (!message) {
            message = {
                id: messageId,
                role: "assistant",
                blocks: [],
                createdAt: Date.now(),
            };
            this.liveTurnMessages.set(messageId, message);
            this.host.emit({ type: "message_upsert", sessionId, message });
        }
        return message;
    }

    /** Returns the current text block within a message, creating it if needed. */
    private ensureTextBlock(sessionId: string, message: UiMessage) {
        const blockId = this.currentTextBlockId ??
            this.nextTextLikeBlockId(message, "text");
        this.currentTextBlockId = blockId;
        return this.ensureTextLikeBlock(sessionId, message, blockId, "text");
    }

    /** Returns the current thinking block within a message, creating it if needed. */
    private ensureThinkingBlock(sessionId: string, message: UiMessage) {
        const blockId = this.currentThinkingBlockId ??
            this.nextTextLikeBlockId(message, "thinking");
        this.currentThinkingBlockId = blockId;
        return this.ensureTextLikeBlock(
            sessionId,
            message,
            blockId,
            "thinking",
        );
    }

    /**
     * Returns the next unused text or thinking block id for a message.
     *
     * message_start resets the current text/thinking anchors between Pi SDK
     * assistant API calls. Since the browser still displays those calls as one
     * assistant turn, the next delta needs a new block id instead of reusing
     * `<message>:text:0` and being rendered before intervening tool blocks.
     */
    private nextTextLikeBlockId(
        message: UiMessage,
        type: "text" | "thinking",
    ) {
        let index =
            message.blocks.filter((block) => block.type === type).length;
        let blockId = `${message.id}:${type}:${index}`;

        while (message.blocks.some((block) => block.id === blockId)) {
            index += 1;
            blockId = `${message.id}:${type}:${index}`;
        }

        return blockId;
    }

    /**
     * Ensures a text-like block (text or thinking) exists in a message.
     * If the block already exists, returns it. Otherwise creates it and emits
     * a message_block_upsert event.
     */
    private ensureTextLikeBlock(
        sessionId: string,
        message: UiMessage,
        blockId: string,
        type: "text" | "thinking",
    ) {
        const existing = message.blocks.find(
            (block): block is Extract<UiBlock, { type: typeof type }> =>
                block.id === blockId && block.type === type,
        );
        if (existing) {
            return existing;
        }

        // Create new block: text blocks start empty, thinking blocks start
        // collapsed so the user can expand them on demand.
        const block: UiBlock = type === "text"
            ? { id: blockId, type: "text", text: "" }
            : { id: blockId, type: "thinking", text: "", collapsed: true };

        this.upsertBlock(message, block);
        this.host.emit({
            type: "message_block_upsert",
            sessionId,
            messageId: message.id,
            block,
        });
        return block;
    }

    /**
     * Returns (or creates) the ToolBlockLocation for a given toolCallId.
     * The location tracks which assistant message owns the tool call and the
     * block ids for the tool_call and tool_result entries.
     */
    private ensureToolBlockLocation(
        sessionId: string,
        toolCallId: string,
    ): ToolBlockLocation {
        const existing = this.toolBlocks.get(toolCallId);
        if (existing) {
            return existing;
        }

        // All tool calls are nested under the current assistant message.
        // If no assistant message exists yet, create one.
        const message = this.ensureAssistantMessage(sessionId);

        const location = {
            messageId: message.id,
            callBlockId: `${message.id}:tool:${toolCallId}:call`,
            resultBlockId: `${message.id}:tool:${toolCallId}:result`,
        };
        this.toolBlocks.set(toolCallId, location);
        return location;
    }

    /**
     * Extracts or generates a tool call id from an event.
     *
     * Events from different providers use different fields for the tool call
     * identifier. If no id is found, generates a synthetic anonymous id for
     * the duration of the tool execution.
     */
    private toolCallId(
        event: unknown,
        phase: "start" | "update" | "end",
    ) {
        const explicit = extractToolCallId(event);
        if (explicit) {
            return explicit;
        }

        if (this.anonymousToolProjectionAmbiguous) {
            return undefined;
        }

        if (phase === "start" && this.anonymousToolCallId) {
            this.anonymousToolProjectionAmbiguous = true;
            this.anonymousToolCallId = undefined;
            const message =
                "Overlapping anonymous tool calls cannot be correlated; live anonymous tool projection is paused until the turn completes.";
            console.error(`[agentaz-server] ${message}`);
            this.host.emit({
                type: "error",
                code: "tool_projection_ambiguous",
                message,
                recoverable: true,
            });
            return undefined;
        }

        // For anonymous tool calls, generate a synthetic id that persists
        // across start/update/end events for the same execution.
        if (phase === "start" || !this.anonymousToolCallId) {
            this.anonymousToolCallId = `anonymous-${++this
                .anonymousToolCallCounter}`;
        }
        return this.anonymousToolCallId;
    }

    /**
     * Inserts or replaces a block within a message's block array.
     * Blocks are matched by id, or by toolCallId for tool_call/tool_result blocks.
     */
    private upsertBlock(message: UiMessage, block: UiBlock) {
        const index = message.blocks.findIndex(
            (item) => item.id === block.id || areSameToolBlock(item, block),
        );
        if (index === -1) {
            message.blocks.push(block);
        }
        else {
            message.blocks[index] = block;
        }
    }

    /**
     * Emits the final state of the current assistant message.
     * Called at agent_end to ensure the browser has the complete message.
     */
    private flushCurrentAssistantMessage(sessionId: string) {
        const message = this.liveTurnMessages.get(
            this.currentAssistantMessageId,
        );
        if (message) {
            this.host.emit({ type: "message_upsert", sessionId, message });
        }
    }

    /**
     * Sends a lightweight session status event for the currently focused session.
     * Includes streaming state, pending message count, and pending approval count.
     */
    private sendStatus(emit: EmitEvent = this.host.emit) {
        const session = this.session;
        if (!session) {
            return;
        }
        emit({
            type: "status",
            sessionId: session.sessionId,
            isStreaming: session.isStreaming,
            pendingMessageCount: session.pendingMessageCount,
            pendingApprovalCount: this.uiContext?.pendingCount ?? 0,
            contextUsage: this.contextUsage(),
            usageStats: this.usageStats(),
        });
    }

    /** Best-effort context window usage from the live Pi SDK session. */
    private contextUsage() {
        try {
            return normalizeContextUsage(this.session?.getContextUsage());
        }
        catch (error) {
            console.warn(
                "[agentaz-server] failed to read context usage",
                error,
            );
            return undefined;
        }
    }

    /** Best-effort cumulative usage stats for the current branch. */
    private usageStats() {
        try {
            const manager = this.requireSessionManager();
            const leafId = manager.getLeafId();
            if (this.cachedUsageStats?.leafId === leafId) {
                return this.cachedUsageStats.value;
            }
            const value = summarizeUsageStatsFromEntries(manager.getBranch());
            this.cachedUsageStats = { leafId, value };
            return value;
        }
        catch (error) {
            console.warn(
                "[agentaz-server] failed to read session usage stats",
                error,
            );
            return undefined;
        }
    }

    /** Clears cumulative usage after a branch-changing operation or event. */
    private invalidateUsageStatsCache() {
        this.cachedUsageStats = undefined;
    }

    /**
     * Returns whether the agent workflow is currently active.
     * True if the session is streaming or has pending queued messages.
     */
    private isWorkflowBusy() {
        const session = this.session;
        return Boolean(
            session?.isStreaming || (session?.pendingMessageCount ?? 0) > 0,
        );
    }

    /**
     * Returns the live Pi session or throws if not initialized.
     * The required parameter controls whether to throw or return undefined
     * when the session isn't initialized (false = safe for dispose).
     */
    private requireSession(
        required?: true,
    ): NonNullable<PiSessionController["session"]>;
    private requireSession(required: false): PiSessionController["session"];
    private requireSession(required = true) {
        this.assertUsable();
        const session = this.session;
        if (!session && required) {
            throw new Error("Pi session is not initialized");
        }
        return session;
    }

    /** Returns the SessionManager or throws if not set. */
    private requireSessionManager() {
        this.assertUsable();
        if (!this.sessionManager) {
            throw new Error("Pi session manager is not initialized");
        }
        return this.sessionManager;
    }

    /** Throws when callers try to use a controller that is being disposed or has been disposed. */
    private assertUsable() {
        if (this.disposed || this.disposing) {
            throw new Error("Pi session controller has been disposed");
        }
    }
}

/** Options for createSessionController. */
export type CreateSessionControllerOptions = {
    cwd: string;
    agentDir: string;
    authStorage: ReturnType<typeof AuthStorage.create>;
    modelRegistry: ReturnType<typeof ModelRegistry.create>;
    approvalTimeoutMs: number;
    host: PiSessionControllerHost;
};

/** Options for openSessionController. */
export type OpenSessionControllerOptions = CreateSessionControllerOptions & {
    sessionFile: string;
};

/**
 * Creates a fresh manager-backed controller for the configured working directory.
 * The live Pi SDK session, extensions, and event subscription are initialized on
 * demand by the first operation that requires them.
 */
export function createSessionController(
    options: CreateSessionControllerOptions,
) {
    const controller = new PiSessionController(
        options.cwd,
        options.agentDir,
        options.authStorage,
        options.modelRegistry,
        options.approvalTimeoutMs,
        options.host,
    );

    // SessionManager.create() already starts a fresh session target.
    controller.attachSessionManager(SessionManager.create(options.cwd));
    return controller;
}

/**
 * Opens an existing manager-backed controller for the configured working directory.
 * The live Pi SDK session, extensions, and event subscription are initialized on
 * demand by the first operation that requires them.
 */
export function openSessionController(
    options: OpenSessionControllerOptions,
) {
    const controller = new PiSessionController(
        options.cwd,
        options.agentDir,
        options.authStorage,
        options.modelRegistry,
        options.approvalTimeoutMs,
        options.host,
    );

    // The cwd override keeps the manager bound to the configured workspace.
    controller.attachSessionManager(
        SessionManager.open(
            options.sessionFile,
            undefined,
            options.cwd,
        ),
    );

    return controller;
}
