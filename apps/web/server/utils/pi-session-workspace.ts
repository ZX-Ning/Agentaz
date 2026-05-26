import {
  AuthStorage,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import type {
  MessageSubmitRequest,
  ModelStateResponse,
  ServerEvent,
  SessionHistoryResponse,
  ThinkingLevel,
  UiLoadedSession,
  UiRequestResponseRequest,
  UiSessionSummary,
} from "../../types/protocol";
import { AgentEventBus } from "./agent-event-bus";
import {
  DEFAULT_THINKING_LEVELS,
  PiSessionController,
  toUiModel,
  toUiSessionSummary,
} from "./pi-session-controller";
import { ensureRequiredPiPackages } from "./pi-required-packages";

/** Startup options for the process-wide Pi session workspace. */
export type PiSessionWorkspaceOptions = {
  cwd: string;
  approvalTimeoutMs: number;
  maxLoadedSessions: number;
};

/**
 * Owns Pi SDK services and the process-resident loaded session working set.
 *
 * The workspace deliberately has no knowledge of browser clients or WebSocket peers. It emits
 * runtime events when session state changes, and separate services project those changes for clients.
 */
export class PiSessionWorkspace {
  private agentDir = getAgentDir();
  private authStorage = AuthStorage.create(join(this.agentDir, "auth.json"));
  private modelRegistry = ModelRegistry.create(
    this.authStorage,
    join(this.agentDir, "models.json"),
  );
  private servicesPromise?: Promise<AgentSessionServices>;
  private sessions = new Map<string, PiSessionController>();
  private persistedSessionCache: UiSessionSummary[] = [];

  constructor(
    private readonly options: PiSessionWorkspaceOptions,
    private readonly eventBus: AgentEventBus,
    private readonly getProtectedSessionIds: () => Iterable<string> = () => [],
  ) {
    void this.getServices().catch((error) => {
      console.error("failed to prewarm Pi SDK services", error);
    });
  }

  /** Working directory used by all loaded and persisted Pi sessions. */
  get cwd() {
    return this.options.cwd;
  }

  /** Cached persisted sessions for the configured working directory. */
  get persistedSessions() {
    return this.persistedSessionCache;
  }

  /** Returns SDK services shared by all loaded sessions for the configured cwd. */
  private getServices() {
    this.servicesPromise ??= this.createServices().catch((error) => {
      this.servicesPromise = undefined;
      throw error;
    });
    return this.servicesPromise;
  }

  /** Creates SDK services after required Pi agent packages are configured. */
  private async createServices() {
    const result = await ensureRequiredPiPackages(this.agentDir);
    if (result.added.length > 0) {
      console.log(
        "[agentaz-server] added required Pi packages to Pi agent settings",
        result,
      );
    }
    return createAgentSessionServices({
      cwd: this.options.cwd,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    });
  }

  /** Returns a readonly projection of currently loaded sessions. */
  loadedSessions(): UiLoadedSession[] {
    return [...this.sessions.values()].map((controller) =>
      controller.toLoadedSession(),
    );
  }

  /** Returns the first loaded session id, used as fallback focus after closing a session. */
  firstLoadedSessionId() {
    return this.sessions.keys().next().value as string | undefined;
  }

  /** Returns whether a session is currently loaded. */
  hasSession(sessionId: string) {
    return this.sessions.has(sessionId);
  }

  /** Refreshes cached persisted session summaries and emits a state change. */
  async refreshPersistedSessionCache() {
    this.persistedSessionCache = await this.listPersistedSessions();
    this.emitStateChanged();
  }

  /** Creates a fresh loaded session. */
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

  /** Opens an existing persisted session, returning an already-loaded controller when possible. */
  async openLoadedSession(sessionFile: string) {
    const normalizedSessionFile = resolve(sessionFile);
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

  /** Returns normalized history for one loaded session. */
  getSessionHistory(sessionId: string): SessionHistoryResponse {
    return this.requireSession(sessionId).getHistory();
  }

  /** Returns HTTP model/thinking state for one loaded session. */
  getSessionModelState(sessionId: string): ModelStateResponse {
    return this.requireSession(sessionId).getModelState();
  }

  /** Returns model picker defaults without creating or initializing a Pi session. */
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

  /** Accepts a prompt-like message over HTTP and continues execution asynchronously. */
  submitMessage(
    sessionId: string,
    request: MessageSubmitRequest,
    onSettled?: () => void,
  ) {
    const controller = this.mutableSession(sessionId);
    const task =
      request.mode === "steer"
        ? controller.steer(request.text, request.images)
        : request.mode === "follow_up"
          ? controller.followUp(request.text, request.images)
          : controller.prompt(request.text, request.images);

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
          await this.refreshPersistedSessionCache();
          this.emitStateChanged();
        } finally {
          onSettled?.();
        }
      });
    this.emitStateChanged();
  }

  /** Aborts one loaded session and pending browser-backed prompts. */
  async abortSession(sessionId: string) {
    await this.mutableSession(sessionId).abort();
    this.emitStateChanged();
  }

  /** Clears queued steer/follow-up messages for one loaded session. */
  async clearSessionQueue(sessionId: string) {
    await this.mutableSession(sessionId).clearQueue();
    this.emitStateChanged();
  }

  /** Resolves one browser-backed extension UI request. */
  resolveUiRequest(
    sessionId: string,
    requestId: string,
    response: UiRequestResponseRequest,
  ) {
    const controller = this.mutableSession(sessionId);
    if ("confirmed" in response) {
      controller.resolveConfirm(requestId, response.confirmed);
    } else if ("value" in response) {
      controller.resolveInput(requestId, response.value);
    } else {
      controller.resolveSelect(
        requestId,
        (response as { selected?: string }).selected,
      );
    }
    this.emitStateChanged();
  }

  /** Disposes every loaded session, used only for process-level teardown. */
  async disposeAll() {
    const controllers = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(controllers.map((controller) => controller.dispose()));
    this.emitStateChanged();
  }

  private async listPersistedSessions(): Promise<UiSessionSummary[]> {
    const sessions = await SessionManager.list(this.options.cwd);
    return sessions.map(toUiSessionSummary);
  }

  /** Frees one idle loaded session only when the working set is at capacity. */
  private async releaseOneAvailableSessionIfAtCapacity() {
    if (this.sessions.size < this.options.maxLoadedSessions) return;

    const protectedSessionIds = new Set(this.getProtectedSessionIds());
    for (const [sessionId, controller] of [...this.sessions]) {
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

  private mutableSession(sessionId: string) {
    return this.requireSession(sessionId);
  }

  private requireSession(sessionId: string) {
    const controller = this.sessions.get(sessionId);
    if (!controller) {
      throw new Error("No loaded session is available for this command.");
    }
    return controller;
  }

  private assertCanLoadAnotherSession() {
    if (this.sessions.size >= this.options.maxLoadedSessions) {
      throw new Error(
        `Loaded session limit reached (${this.options.maxLoadedSessions}). Try again after an active session becomes idle.`,
      );
    }
  }

  private emitServerEvent(event: ServerEvent) {
    this.eventBus.publish({ type: "server_event", event });
  }

  private emitStateChanged() {
    this.eventBus.publish({ type: "state_changed" });
  }
}
