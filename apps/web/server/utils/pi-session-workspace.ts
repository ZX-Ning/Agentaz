import {
  AuthStorage,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { access, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  MessageSubmitRequest,
  ModelStateResponse,
  ServerEvent,
  SessionEntriesResponse,
  SessionEntryInfo,
  SessionHistoryResponse,
  ThinkingLevel,
  UiLoadedSession,
  UiRequestResponseRequest,
  UiSessionSummary,
} from "../../types/protocol";
import type { AgentEventBus } from "./agent-event-bus";
import {
  BadRequestError,
  PersistedSessionNotFoundError,
  SessionBusyError,
  SessionEntryNotFoundError,
  SessionLimitReachedError,
  SessionNotFoundError,
  SessionNotPersistedError,
} from "./domain-errors";
import {
  DEFAULT_THINKING_LEVELS,
  flattenText,
  PiSessionController,
  toUiModel,
  toUiSessionSummary,
} from "./pi-session-controller";
import { ensureRequiredPiPackages } from "./pi-required-packages";

/** Startup options for the process-wide Pi session workspace. */
export type PiSessionWorkspaceOptions = {
  /** Working directory for all Pi sessions. */
  cwd: string;
  /** Timeout in milliseconds for browser-backed extension UI approval prompts. */
  approvalTimeoutMs: number;
  /** Maximum number of Pi sessions that can be loaded simultaneously. */
  maxLoadedSessions: number;
};

/**
 * Process-wide singleton (owned by AgentRuntime) that holds Pi SDK shared services
 * and the loaded-session working set.
 *
 * There is exactly one PiSessionWorkspace per Node.js process, created during
 * Nitro startup by initAgentRuntime. All HTTP routes and WebSocket handlers
 * share the same instance.
 *
 * The workspace has no knowledge of browser clients or WebSocket peers.
 * It emits runtime events on the event bus when session state changes;
 * separate services (SessionProjector, SseAgentHub) translate those events
 * into browser-facing state snapshots and realtime messages.
 *
 * Session lifecycle:
 *   - Sessions are loaded on demand via createLoadedSession() or openLoadedSession().
 *   - When the working set reaches maxLoadedSessions, idle sessions may be evicted.
 *   - Sessions focused by a browser client are protected from eviction
 *     (identified by the getProtectedSessionIds callback).
 *   - Persisted session metadata is cached separately and refreshed after mutations.
 */
export class PiSessionWorkspace {
  /** Pi agent home directory (defaults to ~/.pi or PI_CODING_AGENT_DIR). */
  private agentDir = getAgentDir();
  /** Shared auth storage for API keys and credentials. */
  private authStorage = AuthStorage.create(join(this.agentDir, "auth.json"));
  /** Shared model registry backed by models.json in the agent directory. */
  private modelRegistry = ModelRegistry.create(
    this.authStorage,
    join(this.agentDir, "models.json"),
  );
  /**
   * Lazily-initialized Pi SDK shared services (auth storage, model registry,
   * and other infrastructure shared across all loaded sessions).
   *
   * Created on first access; prewarmed in the constructor to avoid blocking
   * the first session creation on package installation. Required Pi packages
   * are auto-configured in the agent's settings.json on creation.
   */
  private servicesPromise?: Promise<AgentSessionServices>;
  /** The loaded session working set indexed by sessionId. */
  private sessions = new Map<string, PiSessionController>();
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
    private readonly getProtectedSessionIds: () => Iterable<string> = () => [],
  ) {
    // Prewarm Pi SDK services in the background so the first session
    // creation doesn't block on package installation.
    void this.getServices().catch((error) => {
      console.error("failed to prewarm Pi SDK services", error);
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
   * Returns (and lazily creates) Pi SDK services shared by all loaded sessions.
   *
   * The promise is cached so only one initialization runs, even if multiple
   * sessions are being opened concurrently. On failure, the cached promise is
   * reset so the next caller can retry.
   *
   * Creation includes auth storage, model registry setup, and auto-
   * configuration of required Pi packages in settings.json.
   */
  private getServices() {
    this.servicesPromise ??= this.createServices().catch((error) => {
      // Reset on failure so the next caller can retry.
      this.servicesPromise = undefined;
      throw error;
    });
    return this.servicesPromise;
  }

  /**
   * Creates SDK services after ensuring required Pi agent packages are configured.
   * This includes the permission-system and todo extensions needed by Agentaz.
   */
  private async createServices() {
    // Auto-configure required packages (permission-system, todo)
    // in the agent's settings.json. This is idempotent — if the packages
    // are already listed, this is a no-op.
    const result = await ensureRequiredPiPackages(this.agentDir);
    if (result.added.length > 0) {
      console.log(
        "[agentaz-server] added required Pi packages to Pi agent settings",
        result,
      );
    }

    // Create the shared service container: auth, model registry, etc.
    return createAgentSessionServices({
      cwd: this.options.cwd,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    });
  }

  /** Returns a readonly projection of currently loaded sessions for the UI sidebar. */
  loadedSessions(): UiLoadedSession[] {
    return [...this.sessions.values()].map((controller) =>
      controller.toLoadedSession(),
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
    await this.releaseOneAvailableSessionIfAtCapacity();
    this.assertCanLoadAnotherSession();

    const controller = await PiSessionController.create({
      cwd: this.options.cwd,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      getServices: () => this.getServices(),
      emit: (event) => this.emitServerEvent(event),
      approvalTimeoutMs: this.options.approvalTimeoutMs,
      onSessionMetadataChanged: () => this.refreshPersistedSessionCache(),
    });

    this.sessions.set(controller.sessionId, controller);
    this.emitStateChanged();
    return controller;
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
    // Normalize to absolute path for deduplication.
    const normalizedSessionFile = resolve(sessionFile);

    // Check if this file is already loaded.
    const loaded = [...this.sessions.values()].find(
      (controller) =>
        controller.sessionFile &&
        resolve(controller.sessionFile) === normalizedSessionFile,
    );
    if (loaded) return loaded;

    await this.releaseOneAvailableSessionIfAtCapacity();
    this.assertCanLoadAnotherSession();

    const controller = await PiSessionController.open({
      cwd: this.options.cwd,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      getServices: () => this.getServices(),
      emit: (event) => this.emitServerEvent(event),
      approvalTimeoutMs: this.options.approvalTimeoutMs,
      onSessionMetadataChanged: () => this.refreshPersistedSessionCache(),
      sessionFile: normalizedSessionFile,
    });

    this.sessions.set(controller.sessionId, controller);
    this.emitStateChanged();
    return controller;
  }

  /**
   * Renames a persisted session by appending a session_info entry.
   *
   * The sessionFile must belong to the configured cwd's normal persisted
   * session list. This prevents arbitrary path writes while still allowing
   * metadata edits for sessions that are not currently loaded in memory.
   */
  async renamePersistedSession(sessionFile: string, name: string) {
    const normalizedName = name.trim();
    if (!normalizedName) {
      throw new BadRequestError("Session name is required.");
    }
    if (normalizedName.length > 120) {
      throw new BadRequestError("Session name must be 120 characters or less.");
    }

    const normalizedSessionFile =
      await this.requirePersistedSessionFile(sessionFile);
    const loaded = this.findLoadedSessionByFile(normalizedSessionFile);

    if (loaded) {
      await loaded.rename(normalizedName);
    } else {
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
    const normalizedSessionFile =
      await this.requirePersistedSessionFile(sessionFile);
    const loaded = this.findLoadedSessionByFile(normalizedSessionFile);

    if (loaded?.isBusy()) {
      throw new SessionBusyError();
    }

    if (loaded) {
      await loaded.dispose();
      this.sessions.delete(loaded.sessionId);
    }

    const deletedSessionFile = await this.nextSoftDeletedSessionFile(
      normalizedSessionFile,
    );
    await rename(normalizedSessionFile, deletedSessionFile);

    this.eventBus.publish({
      type: "session_removed",
      sessionId: loaded?.sessionId ?? normalizedSessionFile,
      fallbackSessionId: this.firstLoadedSessionId(),
    });
    await this.refreshPersistedSessionCache();
    this.emitStateChanged();

    return {
      sessionId: loaded?.sessionId,
      sessionFile: normalizedSessionFile,
    };
  }

  /** Returns normalized history for one loaded session. */
  getSessionHistory(sessionId: string): SessionHistoryResponse {
    return this.requireSession(sessionId).getHistory();
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
    const controller = this.mutableSession(sessionId);
    this.assertForkRevertReady(controller);

    const sourceFile = controller.sessionFile;
    if (!sourceFile) throw new SessionNotPersistedError();

    let newSessionFile: string | undefined;
    if (options.entryId?.trim()) {
      const entryId = options.entryId.trim();
      this.requireCurrentBranchEntry(controller, entryId);
      const temporaryManager = SessionManager.open(
        sourceFile,
        undefined,
        this.options.cwd,
      );
      newSessionFile = temporaryManager.createBranchedSession(entryId);
      if (newSessionFile && !(await fileExists(newSessionFile))) {
        forceRewriteSessionFile(temporaryManager);
      }
    } else {
      newSessionFile = SessionManager.forkFrom(
        sourceFile,
        this.options.cwd,
      ).getSessionFile();
    }

    if (!newSessionFile) throw new SessionNotPersistedError();

    const normalizedName = options.name?.trim();
    if (normalizedName) {
      SessionManager.open(
        newSessionFile,
        undefined,
        this.options.cwd,
      ).appendSessionInfo(normalizedName);
    }

    const forkedController = await this.openLoadedSession(newSessionFile);
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
    const normalizedEntryId = entryId.trim();
    if (!normalizedEntryId) {
      throw new BadRequestError("Session entry id is required.");
    }

    const controller = this.mutableSession(sessionId);
    this.assertForkRevertReady(controller);
    this.requireCurrentBranchEntry(controller, normalizedEntryId);

    const sessionFile = controller.sessionFile;
    if (!sessionFile) throw new SessionNotPersistedError();

    const sessionManager = controller.getSessionManager();
    const currentName = sessionManager.getSessionName() ?? "";
    sessionManager.branch(normalizedEntryId);
    sessionManager.appendSessionInfo(currentName);

    await controller.dispose();
    this.sessions.delete(sessionId);

    const reopenedController = await this.openLoadedSession(sessionFile);
    await this.refreshPersistedSessionCache();
    this.emitStateChanged();
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
    const state = await this.mutableSession(sessionId).setModel(provider, id);
    this.emitStateChanged();
    return state;
  }

  /** Sets the thinking level for one loaded session and returns the updated HTTP model state. */
  async setSessionThinkingLevel(sessionId: string, level: ThinkingLevel) {
    const state = await this.mutableSession(sessionId).setThinkingLevel(level);
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
  ) {
    const controller = this.mutableSession(sessionId);

    // Dispatch to the correct controller method based on mode.
    const task =
      request.mode === "steer"
        ? controller.steer(request.text, request.images)
        : request.mode === "follow_up"
          ? controller.followUp(request.text, request.images)
          : controller.prompt(request.text, request.images);

    // Attach settlement handlers to the async task.
    // We don't await — the HTTP response returns immediately.
    task
      .catch((error) => {
        console.error("[agentaz-server] message task failed", error);
        this.emitServerEvent({
          type: "error",
          code: "message_failed",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        });
      })
      .finally(async () => {
        try {
          // Refresh persisted cache so newly saved sessions appear.
          await this.refreshPersistedSessionCache();
          this.emitStateChanged();
        } finally {
          // Always release the control lease, even if refresh fails.
          onSettled?.();
        }
      });

    // Emit immediately so the frontend shows the session as busy.
    this.emitStateChanged();
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
    } else if (response.kind === "input") {
      controller.resolveInput(requestId, response.value);
    } else {
      controller.resolveSelect(requestId, response.selected);
    }
    this.emitStateChanged();
  }

  /**
   * Disposes every loaded session, used only for process-level teardown.
   * All controllers are disposed in parallel and the working set is cleared.
   */
  async disposeAll() {
    const controllers = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(controllers.map((controller) => controller.dispose()));
    this.emitStateChanged();
  }

  /** Reads persisted session metadata from the working directory. */
  private async listPersistedSessions(): Promise<UiSessionSummary[]> {
    const sessions = await SessionManager.list(this.options.cwd);
    return sessions.map(toUiSessionSummary);
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
    if (!(await fileExists(base))) return base;
    return `${base}.${Date.now()}`;
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
    if (this.sessions.size < this.options.maxLoadedSessions) return;

    const protectedSessionIds = new Set(this.getProtectedSessionIds());
    for (const [sessionId, controller] of [...this.sessions]) {
      // Skip protected or busy sessions.
      if (protectedSessionIds.has(sessionId) || controller.isBusy()) continue;

      await controller.dispose();
      this.sessions.delete(sessionId);
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

  /** Throws unless the loaded controller can be safely forked or reverted. */
  private assertForkRevertReady(controller: PiSessionController) {
    if (controller.isBusy()) {
      throw new SessionBusyError();
    }
    if (!controller.sessionFile) {
      throw new SessionNotPersistedError();
    }
  }

  /** Returns the selectable current-branch message entries for a controller. */
  private selectableEntries(
    controller: PiSessionController,
  ): SessionEntryInfo[] {
    return controller
      .getEntries()
      .filter((entry) => entry.type === "message")
      .map((entry, index) => {
        const message = entry.message;
        return {
          id: entry.id,
          type: entry.type,
          role: isUiEntryRole(message?.role) ? message.role : undefined,
          summary: summarizeEntryContent(message?.content),
          timestamp: entry.timestamp,
          index,
        };
      });
  }

  /** Ensures an entry id belongs to the current branch. */
  private requireCurrentBranchEntry(
    controller: PiSessionController,
    entryId: string,
  ) {
    if (!controller.getEntries().some((entry) => entry.id === entryId)) {
      throw new SessionEntryNotFoundError();
    }
  }

  /** Throws if the loaded session limit has been reached. */
  private assertCanLoadAnotherSession() {
    if (this.sessions.size >= this.options.maxLoadedSessions) {
      throw new SessionLimitReachedError(this.options.maxLoadedSessions);
    }
  }

  /** Emits a normalized server event on the runtime event bus. */
  private emitServerEvent(event: ServerEvent) {
    this.eventBus.publish({ type: "server_event", event });
  }

  /** Emits a state_changed event to trigger frontend refresh via WebSocket. */
  private emitStateChanged() {
    this.eventBus.publish({ type: "state_changed" });
  }
}

/** Returns whether a path exists and is accessible to the current process. */
async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
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
  return text.length > 100 ? `${text.slice(0, 100)}...` : text;
}

/**
 * Forces the Pi SDK manager to write its current JSONL content.
 *
 * createBranchedSession() intentionally defers file creation for paths that
 * contain no assistant message. Agentaz fork APIs return a loaded persisted
 * session immediately, so those user-only branch files must exist before open.
 */
function forceRewriteSessionFile(sessionManager: SessionManager) {
  (
    sessionManager as unknown as {
      _rewriteFile: () => void;
    }
  )._rewriteFile();
}
