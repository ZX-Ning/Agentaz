import {
    AuthStorage,
    createAgentSessionServices,
    getAgentDir,
    ModelRegistry,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { access, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
    ContextCompactResponse,
    MessageSubmitRequest,
    MessageSubmitResponse,
    ModelStateResponse,
    PermissionConfigResponse,
    PermissionSystemConfig,
    ServerEvent,
    SessionEntriesResponse,
    SessionEntryInfo,
    SessionHistoryResponse,
    ThinkingLevel,
    UiRequestResponseRequest,
    UiRuntimeLoadedSession,
    UiSessionSummary,
} from "@agentaz/protocol";
import type { AgentEventBus } from "../runtime/event-bus.ts";
import {
    BadRequestError,
    PersistedSessionNotFoundError,
    SessionBusyError,
    SessionEntryNotFoundError,
    SessionForkUnavailableError,
    SessionLimitReachedError,
    SessionNotFoundError,
    SessionNotPersistedError,
} from "../errors.ts";
import {
    type ControllerBase,
    createSessionController,
    type CreateSessionControllerOptions,
    DEFAULT_THINKING_LEVELS,
    flattenText,
    openSessionController,
    type OpenSessionControllerOptions,
    type PiSessionControllerHost,
    toUiModel,
    toUiSessionSummary,
} from "./session-controller.ts";
import { ensureRequiredPiPackages } from "./required-packages.ts";
import {
    readProjectPermissionConfig,
    resetProjectPermissionConfig,
    writeProjectPermissionConfig,
} from "../extensions/permission-config.ts";

/** Startup options for the process-wide Pi session workspace. */
export type PiSessionWorkspaceOptions = {
    /** Working directory for all Pi sessions. */
    cwd: string;
    /** Timeout in milliseconds for browser-backed extension UI approval prompts. */
    approvalTimeoutMs: number;
    /** Maximum number of Pi sessions that can be loaded simultaneously. */
    maxLoadedSessions: number;
};

/** Replaceable SDK boundary used by tests without loading Pi extensions. */
export interface PiSessionWorkspaceDependencies {
    agentDir: string;
    ensureRequiredPackages: typeof ensureRequiredPiPackages;
    listPersistedSessions(cwd: string): Promise<UiSessionSummary[]>;
    controllerFactory: {
        create(options: CreateSessionControllerOptions): ControllerBase;
        open(options: OpenSessionControllerOptions): ControllerBase;
    };
    /** Injectable file boundary for deterministic soft-delete failure tests. */
    softDeleteFileSystem?: {
        fileExists(path: string): Promise<boolean>;
        rename(source: string, destination: string): Promise<void>;
    };
}

function defaultWorkspaceDependencies(): PiSessionWorkspaceDependencies {
    return {
        agentDir: getAgentDir(),
        ensureRequiredPackages: ensureRequiredPiPackages,
        listPersistedSessions: async (cwd) =>
            (await SessionManager.list(cwd)).map(toUiSessionSummary),
        controllerFactory: {
            create: createSessionController,
            open: openSessionController,
        },
    };
}

/**
 * Process singleton Pi session workspace owned by AgentRuntime.
 * Owns shared Pi backing stores + loaded-session working set.
 * No browser/SSE deps; emits runtime events for projection/forwarding.
 *
 * Lifecycle:
 *   - Load sessions on demand; evict idle sessions at capacity.
 *   - Browser-focused sessions are protected via getProtectedSessionIds().
 *   - Persisted metadata is cached and refreshed after mutations.
 */
export class PiSessionWorkspace {
    /** Pi agent home directory (defaults to ~/.pi or PI_CODING_AGENT_DIR). */
    private agentDir: string;
    /** Shared auth storage for API keys and credentials. */
    private authStorage: ReturnType<typeof AuthStorage.create>;
    /** Shared model registry backed by models.json in the agent directory. */
    private modelRegistry: ReturnType<typeof ModelRegistry.create>;
    /**
     * Lazily-initialized promise that ensures required Pi packages are
     * configured in the agent's settings.json. This is shared across all
     * loaded sessions (package setup is idempotent), but each controller
     * gets its own Pi SDK AgentSessionServices/resource loader/extension
     * runtime to avoid stale extension context errors.
     *
     * Prewarmed in the constructor to avoid blocking the first session
     * creation on package installation.
     */
    private requiredPackagesPromise?: Promise<void>;
    /** The loaded session working set indexed by sessionId. */
    private sessions = new Map<string, ControllerBase>();
    /**
     * Serializes transitions that inspect or mutate loaded-session ownership.
     * The stored tail always resolves, so one rejected mutation cannot poison
     * later lifecycle requests.
     */
    private lifecycleMutationTail: Promise<void> = Promise.resolve();
    /** Process-local generation used to seed every controller ownership epoch. */
    private historyRevisionGeneration = 0;
    /** Snapshot of persisted session metadata from the working directory. */
    private persistedSessionCache: UiSessionSummary[] = [];

    constructor(
        private readonly options: PiSessionWorkspaceOptions,
        private readonly eventBus: AgentEventBus,
        /**
         * Callback that returns session ids that should not be evicted.
         * Called during eviction to identify sessions a browser client is
         * currently focused on. Defaults to empty set (all sessions evictable).
         */
        private readonly getProtectedSessionIds: () => Iterable<string> =
            () => [],
        private readonly dependencies = defaultWorkspaceDependencies(),
    ) {
        this.agentDir = dependencies.agentDir;
        this.authStorage = AuthStorage.create(
            join(this.agentDir, "auth.json"),
        );
        this.modelRegistry = ModelRegistry.create(
            this.authStorage,
            join(this.agentDir, "models.json"),
        );

        // Prewarm required Pi packages in the background so the first session
        // creation doesn't block on package installation. Extension services
        // are created per-controller — not shared.
        void this.ensureRequiredPackages().catch((error) => {
            console.error("failed to prewarm required Pi packages", error);
        });
    }

    /** Working directory used by all loaded and persisted Pi sessions. */
    get cwd() {
        return this.options.cwd;
    }

    /**
     * Cached persisted sessions for the configured working directory.
     * Updated by refreshPersistedSessionCache() — not live, but refreshed
     * after every session mutation and message completion.
     */
    get persistedSessions() {
        return this.persistedSessionCache;
    }

    /**
     * Ensures required Pi agent packages are configured in settings.json.
     *
     * The promise is cached so only one setup runs, even if multiple
     * sessions are being opened concurrently. On failure, the cached promise
     * is reset so the next caller can retry.
     */
    private ensureRequiredPackages() {
        this.requiredPackagesPromise ??= (async () => {
            try {
                const result = await this.dependencies.ensureRequiredPackages(
                    this.agentDir,
                );
                if (result.added.length > 0) {
                    console.log(
                        "[agentaz-server] added required Pi packages to Pi agent settings",
                        result,
                    );
                }
            }
            catch (error) {
                // Reset on failure so the next caller can retry.
                this.requiredPackagesPromise = undefined;
                throw error;
            }
        })();
        return this.requiredPackagesPromise;
    }

    /**
     * Creates a fresh Pi SDK AgentSessionServices instance for one controller.
     *
     * Shares only process-wide backing objects (AuthStorage, ModelRegistry)
     * that are not extension runtimes. The returned services include a
     * controller-local resource loader and extension runtime, so disposing
     * one loaded session does not invalidate another controller's extensions.
     *
     * Required Pi packages are ensured before creating services.
     */
    private async createSessionServices() {
        await this.ensureRequiredPackages();
        return createAgentSessionServices({
            cwd: this.options.cwd,
            agentDir: this.agentDir,
            authStorage: this.authStorage,
            modelRegistry: this.modelRegistry,
        });
    }

    /** Builds the dependency interface injected into each session controller. */
    private createControllerHost(): PiSessionControllerHost {
        return {
            createServices: () => this.createSessionServices(),
            emit: (event) => this.emitServerEvent(event),
            onSessionMetadataChanged: () => this.refreshPersistedSessionCache(),
        };
    }

    /** Returns a readonly projection of currently loaded sessions for the UI sidebar. */
    loadedSessions(): UiRuntimeLoadedSession[] {
        return [...this.sessions.values()].map((controller) =>
            controller.toLoadedSession()
        );
    }

    /**
     * Returns the first loaded session id, used as a fallback focus target
     * after closing a session or when a new browser client connects.
     */
    firstLoadedSessionId() {
        return this.sessions.keys().next().value as string | undefined;
    }

    /** Returns whether a session is currently loaded in the working set. */
    hasSession(sessionId: string) {
        return this.sessions.has(sessionId);
    }

    /** Reads this workspace's project-level permission-system config. */
    getProjectPermissionConfig(): Promise<PermissionConfigResponse> {
        return readProjectPermissionConfig(this.options.cwd);
    }

    /** Replaces this workspace's project-level permission-system config. */
    setProjectPermissionConfig(
        config: PermissionSystemConfig,
    ): Promise<PermissionConfigResponse> {
        return writeProjectPermissionConfig(this.options.cwd, config);
    }

    /** Removes this workspace's project-level override and returns fallback data. */
    resetProjectPermissionConfig(): Promise<PermissionConfigResponse> {
        return resetProjectPermissionConfig(this.options.cwd);
    }

    /**
     * Refreshes cached persisted session summaries and emits a state change.
     * Called after session mutations and message completions so the sidebar
     * reflects the latest on-disk state.
     */
    async refreshPersistedSessionCache() {
        this.persistedSessionCache = await this.listPersistedSessions();
        this.emitStateChanged();
    }

    /**
     * Creates a fresh persisted session for the configured cwd.
     *
     * Lifecycle:
     *   1. If at capacity, evict one non-protected idle session.
     *   2. Verify capacity is available (throws if not).
     *   3. Create a PiSessionController with a new SessionManager.
     *   4. Register the controller in the working set.
     *   5. Emit a state_changed event.
     */
    async createLoadedSession() {
        return await this.runLifecycleMutation(() =>
            this.createLoadedSessionWithinMutation()
        );
    }

    /** Creates and registers a controller while the lifecycle queue is held. */
    private async createLoadedSessionWithinMutation() {
        await this.releaseOneAvailableSessionIfAtCapacity();
        this.assertCanLoadAnotherSession();

        const controller = this.dependencies.controllerFactory.create({
            cwd: this.options.cwd,
            agentDir: this.agentDir,
            authStorage: this.authStorage,
            modelRegistry: this.modelRegistry,
            approvalTimeoutMs: this.options.approvalTimeoutMs,
            host: this.createControllerHost(),
        });

        return await this.registerControllerWithinMutation(controller);
    }

    /**
     * Opens an existing persisted session by file path.
     *
     * If the session is already loaded, returns the existing controller
     * immediately (deduplication by normalized absolute path).
     * Otherwise, follows the same create path: eviction, capacity check,
     * controller creation, and registration.
     */
    async openLoadedSession(sessionFile: string) {
        const normalizedSessionFile = resolve(sessionFile);
        return await this.runLifecycleMutation(() =>
            this.openLoadedSessionWithinMutation(normalizedSessionFile)
        );
    }

    /** Validates, opens, and registers one persisted file with the queue held. */
    private async openLoadedSessionWithinMutation(
        normalizedSessionFile: string,
    ) {
        // Validate before deduplication. The persisted list is authoritative for
        // paths allowed to cross the SessionManager.open() boundary.
        await this.requirePersistedSessionFile(normalizedSessionFile);

        // Deduplicate after asynchronous validation, inside the transaction.
        const loaded = this.findLoadedSessionByFile(normalizedSessionFile);
        if (loaded) {
            return loaded;
        }

        await this.releaseOneAvailableSessionIfAtCapacity();
        this.assertCanLoadAnotherSession();

        const controller = await this.dependencies.controllerFactory.open({
            cwd: this.options.cwd,
            agentDir: this.agentDir,
            authStorage: this.authStorage,
            modelRegistry: this.modelRegistry,
            approvalTimeoutMs: this.options.approvalTimeoutMs,
            host: this.createControllerHost(),
            sessionFile: normalizedSessionFile,
        });

        return await this.registerControllerWithinMutation(
            controller,
            normalizedSessionFile,
        );
    }

    /**
     * Renames a persisted session by appending a session_info entry.
     *
     * The sessionFile must belong to the configured cwd's normal persisted
     * session list. This prevents arbitrary path writes while still allowing
     * metadata edits for sessions that are not currently loaded in memory.
     */
    async renamePersistedSession(sessionFile: string, name: string) {
        return await this.runLifecycleMutation(() =>
            this.renamePersistedSessionWithinMutation(sessionFile, name)
        );
    }

    /** Renames persisted metadata while the lifecycle queue is held. */
    private async renamePersistedSessionWithinMutation(
        sessionFile: string,
        name: string,
    ) {
        const normalizedName = name.trim();
        if (!normalizedName) {
            throw new BadRequestError("Session name is required.");
        }
        if (normalizedName.length > 120) {
            throw new BadRequestError(
                "Session name must be 120 characters or less.",
            );
        }

        const normalizedSessionFile = await this.requirePersistedSessionFile(
            sessionFile,
        );
        const loaded = this.findLoadedSessionByFile(normalizedSessionFile);

        if (loaded) {
            await loaded.rename(normalizedName);
        }
        else {
            const sessionManager = SessionManager.open(
                normalizedSessionFile,
                undefined,
                this.options.cwd,
            );
            sessionManager.appendSessionInfo(normalizedName);
            await this.refreshPersistedSessionCache();
        }

        this.emitStateChanged();
        return {
            sessionId: loaded?.sessionId,
            sessionFile: normalizedSessionFile,
        };
    }

    /**
     * Soft-deletes a persisted session by renaming its JSONL file.
     *
     * The original content stays on disk, but the new extension is no longer
     * matched by the Pi SDK's .jsonl session scanner. Loaded sessions must be
     * idle so dispose/removal cannot interrupt active agent work.
     */
    async softDeletePersistedSession(sessionFile: string) {
        return await this.runLifecycleMutation(() =>
            this.softDeletePersistedSessionWithinMutation(sessionFile)
        );
    }

    /** Soft-deletes one persisted session while the lifecycle queue is held. */
    private async softDeletePersistedSessionWithinMutation(
        sessionFile: string,
    ) {
        const normalizedSessionFile = await this.requirePersistedSessionFile(
            sessionFile,
        );
        const loaded = this.findLoadedSessionByFile(normalizedSessionFile);
        const loadedSessionId = loaded?.sessionId;

        if (loaded?.isBusy()) {
            throw new SessionBusyError();
        }

        // Destination resolution is fallible and must precede ownership changes.
        const deletedSessionFile = await this.nextSoftDeletedSessionFile(
            normalizedSessionFile,
        );

        if (!loaded || !loadedSessionId) {
            await this.renameSessionFile(
                normalizedSessionFile,
                deletedSessionFile,
            );
        }
        else {
            await this.softDeleteLoadedSessionWithinMutation(
                loaded,
                normalizedSessionFile,
                deletedSessionFile,
            );
        }

        this.eventBus.publish({
            type: "session_removed",
            sessionId: loadedSessionId ?? normalizedSessionFile,
            fallbackSessionId: this.firstLoadedSessionId(),
        });
        await this.refreshPersistedSessionCache();
        this.emitStateChanged();

        return {
            sessionId: loadedSessionId,
            sessionFile: normalizedSessionFile,
        };
    }

    /** Returns normalized history for one loaded session. */
    getSessionHistory(sessionId: string): SessionHistoryResponse {
        return this.requireSession(sessionId).getHistory();
    }

    /**
     * Manually compacts one idle loaded session's active context.
     *
     * Browser-triggered compact is intentionally idle-only. The Pi SDK compact()
     * method can abort active work internally, but the web API rejects busy
     * sessions so users do not lose an in-flight response by surprise.
     */
    async compactSession(
        sessionId: string,
        options: { customInstructions?: string },
    ): Promise<ContextCompactResponse> {
        const controller = this.mutableSession(sessionId);
        if (controller.isBusy()) {
            throw new SessionBusyError();
        }

        const compactTask = controller.compact(options.customInstructions);
        this.emitStateChanged();
        try {
            const result = await compactTask;
            await this.refreshPersistedSessionCache();
            this.emitStateChanged();
            return {
                ok: true,
                sessionId,
                summary: result.summary,
                firstKeptEntryId: result.firstKeptEntryId,
                tokensBefore: result.tokensBefore,
                details: result.details,
                revision: result.revision,
            };
        }
        finally {
            this.emitStateChanged();
        }
    }

    /**
     * Returns selectable fork/revert entries for one loaded session.
     *
     * The list is intentionally limited to message entries on the current
     * root-to-leaf branch. Full Pi SDK tree navigation remains internal until
     * the product has a dedicated tree UI.
     */
    getSessionEntries(sessionId: string): SessionEntriesResponse {
        const controller = this.requireSession(sessionId);
        return {
            sessionId,
            entries: this.selectableEntries(controller),
        };
    }

    /**
     * Forks a loaded persisted session into a new loaded session.
     *
     * Full forks copy the source JSONL file through SessionManager.forkFrom().
     * Entry-scoped forks use a temporary SessionManager opened from the source
     * file before calling createBranchedSession(), because that Pi SDK method
     * mutates the manager instance it is called on.
     */
    async forkSession(
        sessionId: string,
        options: { entryId?: string; name?: string },
    ) {
        return await this.runLifecycleMutation(() =>
            this.forkSessionWithinMutation(sessionId, options)
        );
    }

    /** Forks and opens the replacement while the lifecycle queue is held. */
    private async forkSessionWithinMutation(
        sessionId: string,
        options: { entryId?: string; name?: string },
    ) {
        const controller = this.mutableSession(sessionId);
        this.assertForkRevertReady(controller);

        const sourceFile = controller.sessionFile;
        if (!sourceFile) {
            throw new SessionNotPersistedError();
        }

        let newSessionFile: string | undefined;
        if (options.entryId?.trim()) {
            const entryId = options.entryId.trim();
            this.requireForkableEntry(controller, entryId);
            const temporaryManager = SessionManager.open(
                sourceFile,
                undefined,
                this.options.cwd,
            );
            newSessionFile = temporaryManager.createBranchedSession(entryId);
        }
        else {
            newSessionFile = SessionManager.forkFrom(
                sourceFile,
                this.options.cwd,
            ).getSessionFile();
        }

        if (!newSessionFile) {
            throw new SessionNotPersistedError();
        }

        const normalizedName = options.name?.trim();
        if (normalizedName) {
            SessionManager.open(
                newSessionFile,
                undefined,
                this.options.cwd,
            ).appendSessionInfo(normalizedName);
        }

        const forkedController = await this.openLoadedSessionWithinMutation(
            resolve(newSessionFile),
        );
        await this.refreshPersistedSessionCache();
        this.emitStateChanged();
        return forkedController;
    }

    /**
     * Reverts a loaded persisted session in place to a current-branch entry.
     *
     * SessionManager.branch() only moves the in-memory leaf pointer. Appending
     * a session_info entry after branching persists that leaf position as the
     * last JSONL entry, so reopening the same file restores the reverted path.
     */
    async revertSession(sessionId: string, entryId: string) {
        return await this.runLifecycleMutation(() =>
            this.revertSessionWithinMutation(sessionId, entryId)
        );
    }

    /** Reverts and reopens one controller while the lifecycle queue is held. */
    private async revertSessionWithinMutation(
        sessionId: string,
        entryId: string,
    ) {
        const normalizedEntryId = entryId.trim();
        if (!normalizedEntryId) {
            throw new BadRequestError("Session entry id is required.");
        }

        const controller = this.mutableSession(sessionId);
        this.assertForkRevertReady(controller);
        this.requireCurrentBranchEntry(controller, normalizedEntryId);

        const sessionFile = controller.sessionFile;
        if (!sessionFile) {
            throw new SessionNotPersistedError();
        }

        const sessionManager = controller.getSessionManager();
        const currentName = sessionManager.getSessionName() ?? "";
        const replacementRevision = this.reserveHistoryRevision(controller);
        sessionManager.branch(normalizedEntryId);
        sessionManager.appendSessionInfo(currentName);

        // The original manager now reflects the reverted branch. Raising its
        // revision keeps the recovery path safe if replacement construction fails.
        controller.seedHistoryRevision(replacementRevision);

        let reopenedController: ControllerBase;
        try {
            reopenedController = await this.createReplacementController(
                resolve(sessionFile),
                sessionId,
                replacementRevision,
            );
        }
        catch (error) {
            // The original controller remains registered on its reverted
            // manager state; publish that recovery state before returning.
            this.emitStateChanged();
            throw error;
        }
        this.sessions.set(sessionId, reopenedController);

        let disposeError: unknown;
        try {
            await controller.dispose();
        }
        catch (error) {
            // The replacement owns the session after the swap even if cleanup
            // reports an error; surface the error only after publishing state.
            disposeError = error;
        }

        await this.refreshPersistedSessionCache();
        this.emitStateChanged();
        if (disposeError) {
            throw disposeError;
        }
        return reopenedController;
    }

    /** Returns HTTP model/thinking state for one loaded session. */
    getSessionModelState(sessionId: string): ModelStateResponse {
        return this.requireSession(sessionId).getModelState();
    }

    /**
     * Returns model picker defaults without creating or initializing a Pi session.
     * Used by the global GET /api/agent/models endpoint to populate the picker
     * before any session exists.
     */
    getDefaultModelState(): ModelStateResponse {
        return {
            sessionId: "",
            models: this.modelRegistry.getAvailable().map(toUiModel),
            thinkingLevel: "off",
            availableThinkingLevels: DEFAULT_THINKING_LEVELS,
        };
    }

    /** Sets the model for one loaded session and returns the updated HTTP model state. */
    async setSessionModel(sessionId: string, provider: string, id: string) {
        const state = await this.mutableSession(sessionId).setModel(
            provider,
            id,
        );
        this.emitStateChanged();
        return state;
    }

    /** Sets the thinking level for one loaded session and returns the updated HTTP model state. */
    async setSessionThinkingLevel(sessionId: string, level: ThinkingLevel) {
        const state = await this.mutableSession(sessionId).setThinkingLevel(
            level,
        );
        this.emitStateChanged();
        return state;
    }

    /**
     * Accepts a prompt-like message over HTTP and continues execution asynchronously.
     *
     * Message dispatch is fire-and-forget: the HTTP response returns immediately
     * while the Pi agent loop processes the prompt in the background. When the
     * message task settles (completes or errors):
     *   - Persisted session metadata is refreshed.
     *   - A state_changed event is emitted.
     *   - The onSettled callback is called (typically to release a control lease).
     *
     * Message modes:
     *   - "prompt": Start a new agent turn (the default).
     *   - "steer": Redirect the currently streaming agent output.
     *   - "follow_up": Queue a message for processing after the current turn.
     */
    submitMessage(
        sessionId: string,
        request: MessageSubmitRequest,
        onSettled?: () => void,
    ): MessageSubmitResponse {
        const controller = this.mutableSession(sessionId);
        const turn = request.mode === "prompt"
            ? {
                turnId: crypto.randomUUID(),
                clientMessageId: request.clientMessageId,
            }
            : undefined;

        // Dispatch to the correct controller method based on mode.
        const task = request.mode === "steer"
            ? controller.steer(request.text, request.images)
            : request.mode === "follow_up"
            ? controller.followUp(request.text, request.images)
            : controller.prompt(request.text, request.images, turn!);

        // Attach settlement handlers to the async task.
        // We don't await — the HTTP response returns immediately.
        void task.catch((error) => {
            console.error("[agentaz-server] message task failed", error);
            this.emitServerEvent({
                type: "error",
                code: "message_failed",
                message: error instanceof Error ? error.message : String(error),
                recoverable: true,
            });
        }).finally(async () => {
            try {
                // Refresh persisted cache so newly saved sessions appear.
                await this.refreshPersistedSessionCache();
                this.emitStateChanged();
            }
            finally {
                // Always release the control lease, even if refresh fails.
                onSettled?.();
            }
        }).catch((error) => {
            // The HTTP request has already returned; do not leak refresh failures
            // as unhandled rejections from this background settlement chain.
            console.error(
                "[agentaz-server] failed to refresh session metadata",
                error,
            );
        });

        // Emit immediately so the frontend shows the session as busy.
        this.emitStateChanged();

        return {
            accepted: true,
            sessionId,
            clientMessageId: request.mode === "prompt"
                ? request.clientMessageId
                : undefined,
            turnId: turn?.turnId,
        };
    }

    /**
     * Aborts one loaded session: cancels the active agent workflow and
     * resolves all pending browser-backed extension UI prompts.
     */
    async abortSession(sessionId: string) {
        await this.mutableSession(sessionId).abort();
        this.emitStateChanged();
    }

    /** Clears queued steer/follow-up messages for one loaded session. */
    async clearSessionQueue(sessionId: string) {
        await this.mutableSession(sessionId).clearQueue();
        this.emitStateChanged();
    }

    /**
     * Resolves one browser-backed extension UI request.
     *
     * Dispatches to the appropriate resolution method on the controller
     * based on the explicit response kind:
     *   - { kind: "confirm", confirmed } → resolveConfirm
     *   - { kind: "input", value }       → resolveInput
     *   - { kind: "select", selected }   → resolveSelect
     */
    resolveUiRequest(
        sessionId: string,
        requestId: string,
        response: UiRequestResponseRequest,
    ) {
        const controller = this.mutableSession(sessionId);
        if (response.kind === "confirm") {
            controller.resolveConfirm(requestId, response.confirmed);
        }
        else if (response.kind === "input") {
            controller.resolveInput(requestId, response.value);
        }
        else {
            controller.resolveSelect(requestId, response.selected);
        }
        this.emitStateChanged();
    }

    /**
     * Disposes every loaded session, used only for process-level teardown.
     * All controllers are disposed in parallel and the working set is cleared.
     */
    async disposeAll() {
        await this.runLifecycleMutation(() => this.disposeAllWithinMutation());
    }

    /** Clears and disposes the loaded working set while the queue is held. */
    private async disposeAllWithinMutation() {
        const controllers = [...this.sessions.values()];
        this.sessions.clear();
        this.advanceHistoryRevisionGeneration(...controllers);
        await Promise.all(
            controllers.map((controller) => controller.dispose()),
        );
        this.emitStateChanged();
    }

    /** Runs one ownership transition after all previously queued transitions. */
    private async runLifecycleMutation<T>(mutation: () => Promise<T> | T) {
        const result = this.lifecycleMutationTail.then(mutation);
        this.lifecycleMutationTail = result.then(
            () => undefined,
            () => undefined,
        );
        return await result;
    }

    /**
     * Registers a newly constructed controller or disposes it if a defensive
     * duplicate check finds ownership was already established.
     */
    private async registerControllerWithinMutation(
        controller: ControllerBase,
        normalizedSessionFile?: string,
    ) {
        const duplicateByFile = normalizedSessionFile
            ? this.findLoadedSessionByFile(normalizedSessionFile)
            : undefined;
        const duplicate = duplicateByFile ?? this.sessions.get(
            controller.sessionId,
        );
        if (duplicate) {
            await controller.dispose();
            return duplicate;
        }

        try {
            controller.seedHistoryRevision(
                this.reserveHistoryRevision(controller),
            );
            this.sessions.set(controller.sessionId, controller);
            this.emitStateChanged();
            return controller;
        }
        catch (error) {
            if (this.sessions.get(controller.sessionId) !== controller) {
                await controller.dispose();
            }
            throw error;
        }
    }

    /** Reads persisted session metadata from the working directory. */
    private async listPersistedSessions(): Promise<UiSessionSummary[]> {
        return await this.dependencies.listPersistedSessions(this.options.cwd);
    }

    /** Finds a loaded controller by normalized session file path. */
    private findLoadedSessionByFile(normalizedSessionFile: string) {
        return [...this.sessions.values()].find(
            (controller) =>
                controller.sessionFile &&
                resolve(controller.sessionFile) === normalizedSessionFile,
        );
    }

    /**
     * Validates that a session file is one of the current cwd's normal sessions.
     *
     * The persisted session list comes from the Pi SDK and only includes .jsonl
     * files under this workspace's session directory, so membership gives us both
     * existence and workspace-scope validation before metadata writes or renames.
     */
    private async requirePersistedSessionFile(sessionFile: string) {
        if (!sessionFile?.trim()) {
            throw new BadRequestError("Session file is required.");
        }

        const normalizedSessionFile = resolve(sessionFile);
        const persisted = await this.listPersistedSessions();
        const allowedFiles = new Set(
            persisted
                .map((session) => session.file)
                .filter(Boolean)
                .map((file) => resolve(file)),
        );

        if (!allowedFiles.has(normalizedSessionFile)) {
            throw new PersistedSessionNotFoundError();
        }

        return normalizedSessionFile;
    }

    /** Returns a non-conflicting filename for a soft-deleted session file. */
    private async nextSoftDeletedSessionFile(sessionFile: string) {
        const base = `${sessionFile}.deleted`;
        const exists = this.dependencies.softDeleteFileSystem?.fileExists ??
            fileExists;
        if (!(await exists(base))) {
            return base;
        }
        return `${base}.${Date.now()}`;
    }

    /** Renames a session file through the injectable filesystem boundary. */
    private renameSessionFile(source: string, destination: string) {
        const renameFile = this.dependencies.softDeleteFileSystem?.rename ??
            rename;
        return renameFile(source, destination);
    }

    /**
     * Soft-deletes a loaded controller without exposing an ownership gap.
     *
     * A dormant replacement takes ownership before the old controller is
     * disposed. Rename is the commit point. Cleanup failure after commit rolls
     * the file back and reopens a usable controller before returning the error.
     */
    private async softDeleteLoadedSessionWithinMutation(
        loaded: ControllerBase,
        sourceFile: string,
        deletedFile: string,
    ) {
        const sessionId = loaded.sessionId;
        const recoveryRevision = this.reserveHistoryRevision(loaded);
        const recovery = await this.createReplacementController(
            sourceFile,
            sessionId,
            recoveryRevision,
        );

        // From this point, every pre-commit failure leaves recovery registered.
        this.sessions.set(sessionId, recovery);
        try {
            await loaded.dispose();
        }
        catch (error) {
            this.emitStateChanged();
            throw error;
        }

        try {
            await this.renameSessionFile(sourceFile, deletedFile);
        }
        catch (error) {
            this.emitStateChanged();
            throw error;
        }

        // Rename committed. Remove the recovery owner only while disposing it.
        const rollbackRevision = this.reserveHistoryRevision(recovery);
        this.sessions.delete(sessionId);
        try {
            await recovery.dispose();
        }
        catch (cleanupError) {
            await this.recoverSoftDeleteAfterCommitFailure(
                sessionId,
                sourceFile,
                deletedFile,
                rollbackRevision,
                cleanupError,
            );
        }
    }

    /** Rolls back a committed rename and restores a fresh registered owner. */
    private async recoverSoftDeleteAfterCommitFailure(
        sessionId: string,
        sourceFile: string,
        deletedFile: string,
        recoveryRevision: number,
        cleanupError: unknown,
    ): Promise<never> {
        try {
            await this.renameSessionFile(deletedFile, sourceFile);
            const replacement = await this.createReplacementController(
                sourceFile,
                sessionId,
                recoveryRevision,
            );
            this.sessions.set(sessionId, replacement);
            this.emitStateChanged();
        }
        catch (recoveryError) {
            throw new AggregateError(
                [cleanupError, recoveryError],
                "Soft-delete cleanup and recovery failed.",
            );
        }
        throw cleanupError;
    }

    /** Constructs an unregistered controller for an atomic ownership swap. */
    private async createReplacementController(
        sessionFile: string,
        expectedSessionId: string,
        revision: number,
    ) {
        const controller = await this.dependencies.controllerFactory.open({
            cwd: this.options.cwd,
            agentDir: this.agentDir,
            authStorage: this.authStorage,
            modelRegistry: this.modelRegistry,
            approvalTimeoutMs: this.options.approvalTimeoutMs,
            host: this.createControllerHost(),
            sessionFile,
        });

        if (controller.sessionId !== expectedSessionId) {
            await controller.dispose();
            throw new Error(
                `Replacement session id mismatch: expected ${expectedSessionId}.`,
            );
        }
        controller.seedHistoryRevision(revision);
        return controller;
    }

    /**
     * Frees one idle loaded session only when the working set is at capacity.
     *
     * Iterates sessions in insertion order and disposes the first one that:
     *   - Is not protected (not focused by any connected browser client).
     *   - Is not busy (agent workflow is idle, no pending UI prompts).
     *
     * Emits a session_removed event so presence and projector can update.
     */
    private async releaseOneAvailableSessionIfAtCapacity() {
        if (this.sessions.size < this.options.maxLoadedSessions) {
            return;
        }

        const protectedSessionIds = new Set(this.getProtectedSessionIds());
        for (const [sessionId, controller] of [...this.sessions]) {
            // Skip protected or busy sessions.
            if (
                protectedSessionIds.has(sessionId) || controller.isBusy()
            ) {
                continue;
            }

            this.sessions.delete(sessionId);
            this.advanceHistoryRevisionGeneration(controller);
            await controller.dispose();
            this.eventBus.publish({
                type: "session_removed",
                sessionId,
                fallbackSessionId: this.firstLoadedSessionId(),
            });
            this.emitStateChanged();
            return;
        }
    }

    /** Alias for requireSession — indicates the caller intends to mutate. */
    private mutableSession(sessionId: string) {
        return this.requireSession(sessionId);
    }

    /** Returns the controller for a session or throws if not found. */
    private requireSession(sessionId: string) {
        const controller = this.sessions.get(sessionId);
        if (!controller) {
            throw new SessionNotFoundError();
        }
        return controller;
    }

    /** Advances the O(1) generation past every currently known revision. */
    private reserveHistoryRevision(...controllers: ControllerBase[]) {
        this.advanceHistoryRevisionGeneration(
            ...this.sessions.values(),
            ...controllers,
        );
        this.historyRevisionGeneration += 1;
        return this.historyRevisionGeneration;
    }

    /** Records revision progress before a controller can leave workspace ownership. */
    private advanceHistoryRevisionGeneration(
        ...controllers: ControllerBase[]
    ) {
        for (const controller of controllers) {
            this.historyRevisionGeneration = Math.max(
                this.historyRevisionGeneration,
                controller.historyRevision(),
            );
        }
    }

    /** Throws unless the loaded controller can be safely forked or reverted. */
    private assertForkRevertReady(controller: ControllerBase) {
        if (controller.isBusy()) {
            throw new SessionBusyError();
        }
        if (!controller.sessionFile) {
            throw new SessionNotPersistedError();
        }
    }

    /** Returns the selectable current-branch message entries for a controller. */
    private selectableEntries(
        controller: ControllerBase,
    ): SessionEntryInfo[] {
        return controller
            .getEntries()
            .filter((entry) => entry.type === "message")
            .map((entry, index) => {
                const message = entry.message;
                const content = message && typeof message === "object" &&
                        "content" in message
                    ? message.content
                    : undefined;
                return {
                    id: entry.id,
                    type: entry.type,
                    role: isUiEntryRole(message?.role)
                        ? message.role
                        : undefined,
                    summary: summarizeEntryContent(content),
                    timestamp: entry.timestamp,
                    index,
                };
            });
    }

    /** Ensures an entry id belongs to the current branch. */
    private requireCurrentBranchEntry(
        controller: ControllerBase,
        entryId: string,
    ) {
        if (
            !controller.getEntries().some((entry) => entry.id === entryId)
        ) {
            throw new SessionEntryNotFoundError();
        }
    }

    /** Rejects entry forks that the SDK would defer instead of materializing. */
    private requireForkableEntry(
        controller: ControllerBase,
        entryId: string,
    ) {
        const entries = controller.getEntries();
        const targetIndex = entries.findIndex((entry) => entry.id === entryId);
        if (targetIndex === -1) {
            throw new SessionEntryNotFoundError();
        }

        const hasAssistant = entries.slice(0, targetIndex + 1).some(
            (entry) =>
                entry.type === "message" &&
                entry.message.role === "assistant",
        );
        if (!hasAssistant) {
            throw new SessionForkUnavailableError();
        }
    }

    /** Throws if the loaded session limit has been reached. */
    private assertCanLoadAnotherSession() {
        if (this.sessions.size >= this.options.maxLoadedSessions) {
            throw new SessionLimitReachedError(
                this.options.maxLoadedSessions,
            );
        }
    }

    /** Emits a normalized server event on the runtime event bus. */
    private emitServerEvent(event: ServerEvent) {
        this.eventBus.publish({ type: "server_event", event });
    }

    /** Emits state_changed so SSE clients refresh their snapshots. */
    private emitStateChanged() {
        this.eventBus.publish({ type: "state_changed" });
    }
}

/** Returns whether a path exists and is accessible to the current process. */
async function fileExists(path: string) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}

/** Returns whether an SDK message role can be exposed through SessionEntryInfo. */
function isUiEntryRole(role: unknown): role is "user" | "assistant" {
    return role === "user" || role === "assistant";
}

/** Builds a compact one-line preview for a fork/revert picker entry. */
function summarizeEntryContent(content: unknown) {
    const text = flattenText(content).replace(/\s+/g, " ").trim();
    return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}
