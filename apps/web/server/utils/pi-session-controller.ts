import {
  createAgentSessionFromServices,
  SessionManager,
  type AgentSessionServices,
  type AuthStorage,
  type CreateAgentSessionResult,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type {
  ImagePayload,
  ModelStateResponse,
  ServerEvent,
  SessionHistoryResponse,
  ThinkingLevel,
  UiBlock,
  UiLoadedSession,
  UiMessage,
  UiModel,
  UiSessionSummary,
} from "../../types/protocol";
import { WebExtensionUIContext } from "./extension-ui-context";
import { UnknownModelError } from "./domain-errors";
import { ensurePermissionConfig } from "./permission-config";

/** Emits a normalized server event to the runtime event bus. */
export type EmitEvent = (event: ServerEvent) => void;

/**
 * Model and thinking-level changes requested while a session is still busy.
 *
 * When the user changes the model or thinking level while the agent is
 * streaming or has pending messages, the change is deferred. It is applied
 * automatically when the session becomes idle (via applyPendingSettingsIfIdle).
 */
type PendingSettings = {
  model?: any;
  thinkingLevel?: ThinkingLevel;
};

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

/** The complete set of thinking levels exposed through the web UI. */
export const DEFAULT_THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/**
 * Owns one live Pi SDK session and its browser-facing integration.
 *
 * A controller is independent from WebSocket connection lifetime. It keeps
 * streaming, queue, model/thinking state, extension UI prompts, and event
 * subscriptions alive until the registry explicitly closes or disposes the
 * loaded session.
 *
 * Key responsibilities:
 *   - Session initialization: lazy loading of Pi SDK services and session binding.
 *   - Message dispatch: prompt(), steer(), followUp() with queue management.
 *   - Transcript streaming: building UiBlock/UiMessage projections from Pi SDK events.
 *   - Model/thinking: immediate vs deferred setting while session is busy.
 *   - Extension UI: bridging Pi extension prompts to the browser via WebExtensionUIContext.
 *   - History: caching and normalizing the transcript for HTTP responses.
 */
export class PiSessionController {
  /** The result of createAgentSessionFromServices — holds the live Pi session. */
  private sessionResult?: CreateAgentSessionResult;
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
  /** Deferred model/thinking changes waiting for the session to become idle. */
  private pendingSettings: PendingSettings = {};

  // ── Transcript projection state ──────────────────────────────────────
  /** The current assistant message being built from streaming deltas. */
  private currentAssistantMessageId: string = crypto.randomUUID();
  /** Tracked text block id within the current assistant message. */
  private currentTextBlockId?: string;
  /** Tracked thinking block id within the current assistant message. */
  private currentThinkingBlockId?: string;
  /** Full transcript indexed by message id (live streaming + cached responses). */
  private transcript = new Map<string, UiMessage>();
  /** Maps tool call ids to their location in the transcript. */
  private toolBlocks = new Map<string, ToolBlockLocation>();
  /** Synthetic id for anonymous tool calls that lack explicit toolCallId fields. */
  private anonymousToolCallId?: string;
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

  private constructor(
    private readonly cwd: string,
    private readonly agentDir: string,
    private readonly authStorage: ReturnType<typeof AuthStorage.create>,
    private readonly modelRegistry: ReturnType<typeof ModelRegistry.create>,
    private readonly getServices: () => Promise<AgentSessionServices>,
    private readonly emit: EmitEvent,
    private readonly approvalTimeoutMs: number,
    private readonly onSessionMetadataChanged: () => void | Promise<void>,
  ) {}

  /**
   * Creates a fresh persisted session for the configured working directory.
   *
   * Steps:
   *   1. Create a PiSessionController with the given options.
   *   2. Create a new SessionManager (generates a new session file).
   *   3. Initialize the controller with the session manager.
   *   4. Return the controller (the session is lazily initialized on first use).
   */
  static async create(options: {
    cwd: string;
    agentDir: string;
    authStorage: ReturnType<typeof AuthStorage.create>;
    modelRegistry: ReturnType<typeof ModelRegistry.create>;
    getServices: () => Promise<AgentSessionServices>;
    emit: EmitEvent;
    approvalTimeoutMs: number;
    onSessionMetadataChanged: () => void | Promise<void>;
  }) {
    const controller = new PiSessionController(
      options.cwd,
      options.agentDir,
      options.authStorage,
      options.modelRegistry,
      options.getServices,
      options.emit,
      options.approvalTimeoutMs,
      options.onSessionMetadataChanged,
    );

    // Create a fresh SessionManager — allocates a new session file
    // and writes the initial session header.
    const sessionManager = SessionManager.create(options.cwd);
    sessionManager.newSession();
    await controller.init(sessionManager);
    return controller;
  }

  /**
   * Opens an existing persisted session file for the configured working directory.
   *
   * Unlike create(), this does not call sessionManager.newSession() — the
   * session file already exists. The SessionManager is opened directly from
   * the file path, and the controller is initialized from that manager.
   */
  static async open(options: {
    cwd: string;
    agentDir: string;
    authStorage: ReturnType<typeof AuthStorage.create>;
    modelRegistry: ReturnType<typeof ModelRegistry.create>;
    getServices: () => Promise<AgentSessionServices>;
    emit: EmitEvent;
    approvalTimeoutMs: number;
    onSessionMetadataChanged: () => void | Promise<void>;
    sessionFile: string;
  }) {
    const controller = new PiSessionController(
      options.cwd,
      options.agentDir,
      options.authStorage,
      options.modelRegistry,
      options.getServices,
      options.emit,
      options.approvalTimeoutMs,
      options.onSessionMetadataChanged,
    );

    // Open the existing session file. The third argument (cwd) is used
    // to maintain the SessionManager's working directory reference.
    controller.sessionManager = SessionManager.open(
      options.sessionFile,
      undefined,
      options.cwd,
    );

    return controller;
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
      this.session?.sessionId ?? this.requireSessionManager().getSessionId()
    );
  }

  /**
   * Current session file path for persisted sessions.
   * Falls back to the SessionManager's file path before initialization.
   */
  get sessionFile() {
    return (
      this.session?.sessionFile ?? this.requireSessionManager().getSessionFile()
    );
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
    await this.onSessionMetadataChanged();
  }

  /**
   * Converts this loaded session into a browser sidebar/status row.
   * Includes runtime state (isWorking, isStreaming, pending counts)
   * and extension widget projections.
   */
  toLoadedSession(): UiLoadedSession {
    const session = this.session;
    const sessionId = this.sessionId;
    const sessionFile = this.sessionFile;
    const summary = summarizeSessionManager(this.requireSessionManager());
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
    };
  }

  /**
   * Sends a prompt to this session and waits for the Pi agent loop to finish.
   * This is the primary message entry point — starts a new agent turn.
   */
  async prompt(text: string, images?: ImagePayload[]) {
    await this.ensureInitialized();
    await this.requireSession().prompt(text, { images: toPiImages(images) });
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
    this.emit({
      type: "queue_update",
      sessionId: this.sessionId,
      steering: [],
      followUp: [],
    });
    this.sendStatus();
    console.log("[agentaz-server] cleared queue", cleared);
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
      : this.requireSessionManager().buildSessionContext();
    const restoredModel = restored?.model
      ? this.modelRegistry.find(restored.model.provider, restored.model.modelId)
      : undefined;

    return {
      sessionId: this.sessionId,
      models: this.modelRegistry.getAvailable().map(toUiModel),
      current: session?.model
        ? toUiModel(session.model)
        : restoredModel
          ? toUiModel(restoredModel)
          : undefined,
      thinkingLevel:
        session?.thinkingLevel ??
        normalizeThinkingLevel(restored?.thinkingLevel),
      availableThinkingLevels:
        session?.getAvailableThinkingLevels() ?? DEFAULT_THINKING_LEVELS,
      pendingModel: this.pendingSettings.model
        ? toUiModel(this.pendingSettings.model)
        : undefined,
      pendingThinkingLevel: this.pendingSettings.thinkingLevel,
    };
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
    if (!model) throw new UnknownModelError(provider, id);

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
   * Releases subscriptions, cancels pending prompts, and disposes the
   * underlying SDK session. After disposal, the controller should not be used.
   */
  async dispose() {
    this.uiContext?.cancelAll();
    this.unsubscribe?.();
    this.requireSession(false)?.dispose();
  }

  /**
   * Returns normalized chat history for HTTP consumption.
   *
   * The result is cached until the transcript changes. Cache invalidation
   * happens in onSessionEvent whenever a message_update, tool_* event, or
   * agent_end event is received.
   */
  getHistory(): SessionHistoryResponse {
    if (this.cachedHistory) return this.cachedHistory;
    const session = this.session;
    // If the Pi session isn't initialized, fall back to the SessionManager's
    // persisted messages from disk.
    const messages =
      session?.messages ??
      this.requireSessionManager().buildSessionContext().messages;
    this.cachedHistory = {
      sessionId: this.sessionId,
      messages: normalizeMessages(messages as any[]),
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
  getEntries(): any[] {
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
  }

  /** Sets the SessionManager and triggers lazy session initialization. */
  private async init(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
    await this.ensureInitialized();
  }

  /**
   * Ensures the Pi SDK session is initialized exactly once.
   *
   * Uses a dedup pattern: if multiple callers call ensureInitialized
   * concurrently, only one initialization runs and the others wait on
   * the shared initPromise.
   */
  private async ensureInitialized() {
    if (this.sessionResult) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initializeSession();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }

  /**
   * Full session initialization: creates the Pi SDK session, binds extensions,
   * and subscribes to session events for streaming transcript projection.
   */
  private async initializeSession() {
    // Ensure the permission-system config exists in the agent directory.
    // This is idempotent — if the config already exists, it's a no-op.
    await ensurePermissionConfig(this.agentDir);

    // Create the Pi SDK session from shared services and this session's
    // SessionManager. This wires up the model, tools, permissions, etc.
    this.sessionResult = await createAgentSessionFromServices({
      services: await this.getServices(),
      sessionManager: this.requireSessionManager(),
    });

    const session = this.requireSession();

    // Create the WebExtensionUIContext that bridges Pi extension prompts
    // (select, input, confirm) to WebSocket events for the browser.
    this.uiContext = new WebExtensionUIContext(
      session.sessionId,
      this.emit,
      this.approvalTimeoutMs,
      () => this.sendStatus(),
    );

    // Bind extensions with the UI context and an error handler.
    // The uiContext is cast to any because the Pi SDK's ExtensionUIContext
    // interface isn't fully imported at the type level.
    await session.bindExtensions({
      uiContext: this.uiContext as any,
      onError: (error) => {
        console.error("[agentaz-server] extension error", error);
        this.emit({
          type: "error",
          code: "extension_error",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        });
      },
    });

    // Subscribe to all session events for transcript streaming.
    // The unsubscribe function is stored for cleanup on dispose.
    this.unsubscribe = session.subscribe((event) =>
      this.onSessionEvent(event as any),
    );
  }

  /**
   * Applies any pending model/thinking level changes if the session
   * is now idle. Called from the queue_update and agent_end event handlers.
   */
  private async applyPendingSettingsIfIdle() {
    const session = this.session;
    if (!session || this.isWorkflowBusy()) return;

    // Snapshot and clear pending settings before applying, so the
    // getModelState() call in setModel/setThinkingLevel doesn't
    // re-read the stale pending values.
    const { model, thinkingLevel } = this.pendingSettings;
    this.pendingSettings = {};

    if (model) {
      await session.setModel(model);
    }
    if (thinkingLevel) {
      session.setThinkingLevel(thinkingLevel);
    }
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
   *   - agent_end: Agent turn completed; flush the current assistant message.
   *   - thinking_level_changed: Update the frontend status.
   *   - session_info_changed: Notify the workspace to refresh persisted metadata.
   */
  private onSessionEvent(event: any) {
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
          this.emit({
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
        case "agent_end":
          this.sendStatus();
          // Flush the final state of the current assistant message.
          this.flushCurrentAssistantMessage(sessionId);
          // Reset transcript state for the next agent turn.
          this.currentAssistantMessageId = crypto.randomUUID();
          this.currentTextBlockId = undefined;
          this.currentThinkingBlockId = undefined;
          this.toolBlocks.clear();
          this.toolResultEmittedLength.clear();
          this.anonymousToolCallId = undefined;
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
    } catch (error) {
      console.error("[agentaz-server] failed to forward session event", error);
    }
  }

  /** Notifies the workspace that session metadata changed (name, first message, etc.). */
  private async notifySessionMetadataChanged() {
    try {
      await this.onSessionMetadataChanged();
    } catch (error) {
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
  private forwardMessageUpdate(sessionId: string, event: any) {
    const messageEvent =
      event.assistantMessageEvent ?? event.messageEvent ?? event;

    // Text delta: append to the current text block in the transcript.
    if (messageEvent.type === "text_delta") {
      this.appendAssistantBlockDelta(
        sessionId,
        event.messageId,
        "text",
        messageEvent.delta ?? "",
      );
    }

    // Thinking delta: append to the current thinking block (initially collapsed).
    if (messageEvent.type === "thinking_delta") {
      this.appendAssistantBlockDelta(
        sessionId,
        event.messageId,
        "thinking",
        messageEvent.delta ?? "",
      );
    }
  }

  /**
   * Appends a delta to an assistant message block and emits a message_block_delta
   * WebSocket event for realtime streaming display in the browser.
   */
  private appendAssistantBlockDelta(
    sessionId: string,
    messageId: string | undefined,
    blockType: "text" | "thinking",
    delta: string,
  ) {
    const message = this.ensureAssistantMessage(sessionId, messageId);
    const block =
      blockType === "text"
        ? this.ensureTextBlock(sessionId, message)
        : this.ensureThinkingBlock(sessionId, message);

    // Accumulate the delta text in the block.
    block.text += delta;

    // Emit the delta for realtime streaming display.
    this.emit({
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
    event: any,
    status: Extract<UiBlock, { type: "tool_call" }>["status"],
  ) {
    // Determine the tool call id. Events from different providers use
    // different shapes — toolCallId handles extraction from known fields.
    const toolCallId = this.toolCallId(
      event,
      status === "pending" ? "start" : "update",
    );

    // Ensure we have a location mapping for this tool call.
    const location = this.ensureToolBlockLocation(sessionId, toolCallId);
    const message = this.ensureAssistantMessage(sessionId, location.messageId);

    // Try to find an existing tool_call block — either by toolCallId
    // or by the callBlockId from our location mapping.
    const existing =
      findToolCallBlock(message, toolCallId) ??
      message.blocks.find(
        (block): block is Extract<UiBlock, { type: "tool_call" }> =>
          block.id === location.callBlockId && block.type === "tool_call",
      );

    // Build the block, merging existing data for fields that aren't in every event.
    const block: UiBlock = {
      id: location.callBlockId,
      type: "tool_call",
      toolCallId,
      toolName:
        event.toolName ??
        event.name ??
        event.tool ??
        existing?.toolName ??
        "tool",
      input: extractToolInput(event) ?? existing?.input,
      status,
    };

    this.upsertBlock(message, block);
    this.emit({
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
  private streamToolResultDelta(sessionId: string, event: any) {
    const partialResult = event.partialResult;
    if (!partialResult) return;

    const toolCallId = this.toolCallId(event, "update");
    const location = this.ensureToolBlockLocation(sessionId, toolCallId);
    const fullText = flattenText(partialResult.content ?? []);

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
      this.emit({
        type: "message_block_upsert",
        sessionId,
        messageId: message.id,
        block,
      });
      this.toolResultEmittedLength.set(toolCallId, 0);
    }

    const delta = fullText.slice(this.toolResultEmittedLength.get(toolCallId)!);
    if (delta.length > 0) {
      this.emit({
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
  private completeToolCallBlock(sessionId: string, event: any) {
    const isError = Boolean(event.isError ?? event.error);

    // Update the tool_call block to its final status.
    this.upsertToolCallBlock(sessionId, event, isError ? "error" : "completed");

    // Create the result block with summarized content.
    const toolCallId = this.toolCallId(event, "end");
    const location = this.ensureToolBlockLocation(sessionId, toolCallId);
    const message = this.ensureAssistantMessage(sessionId, location.messageId);

    // Truncate long results to 500 chars for browser display.
    // Extract .content from AgentToolResult objects (same shape as partialResult)
    // so that flattenText sees the text array rather than the wrapper object.
    const rawResult = event.result ?? event.output ?? event.error;
    const summary = summarizeToolResult(rawResult?.content ?? rawResult);

    const resultBlock: UiBlock = {
      id: location.resultBlockId,
      type: "tool_result",
      toolCallId,
      content: summary,
      isError,
    };

    this.upsertBlock(message, resultBlock);
    this.emit({
      type: "message_block_upsert",
      sessionId,
      messageId: message.id,
      block: resultBlock,
    });

    // Clean up streaming result tracking.
    this.toolResultEmittedLength.delete(toolCallId);

    // Clean up anonymous tool call tracking when this tool completes.
    if (!extractToolCallId(event) && this.anonymousToolCallId === toolCallId) {
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
    let message = this.transcript.get(messageId);
    if (!message) {
      message = {
        id: messageId,
        role: "assistant",
        blocks: [],
        createdAt: Date.now(),
      };
      this.transcript.set(messageId, message);
      this.emit({ type: "message_upsert", sessionId, message });
    }
    return message;
  }

  /** Returns the current text block within a message, creating it if needed. */
  private ensureTextBlock(sessionId: string, message: UiMessage) {
    const blockId =
      this.currentTextBlockId ?? this.nextTextLikeBlockId(message, "text");
    this.currentTextBlockId = blockId;
    return this.ensureTextLikeBlock(sessionId, message, blockId, "text");
  }

  /** Returns the current thinking block within a message, creating it if needed. */
  private ensureThinkingBlock(sessionId: string, message: UiMessage) {
    const blockId =
      this.currentThinkingBlockId ??
      this.nextTextLikeBlockId(message, "thinking");
    this.currentThinkingBlockId = blockId;
    return this.ensureTextLikeBlock(sessionId, message, blockId, "thinking");
  }

  /**
   * Returns the next unused text or thinking block id for a message.
   *
   * message_start resets the current text/thinking anchors between Pi SDK
   * assistant API calls. Since the browser still displays those calls as one
   * assistant turn, the next delta needs a new block id instead of reusing
   * `<message>:text:0` and being rendered before intervening tool blocks.
   */
  private nextTextLikeBlockId(message: UiMessage, type: "text" | "thinking") {
    let index = message.blocks.filter((block) => block.type === type).length;
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
    if (existing) return existing;

    // Create new block: text blocks start empty, thinking blocks start
    // collapsed so the user can expand them on demand.
    const block: UiBlock =
      type === "text"
        ? { id: blockId, type: "text", text: "" }
        : { id: blockId, type: "thinking", text: "", collapsed: true };

    this.upsertBlock(message, block);
    this.emit({
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
    if (existing) return existing;

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
  private toolCallId(event: any, phase: "start" | "update" | "end") {
    const explicit = extractToolCallId(event);
    if (explicit) return explicit;

    // For anonymous tool calls, generate a synthetic id that persists
    // across start/update/end events for the same execution.
    if (phase === "start" || !this.anonymousToolCallId) {
      this.anonymousToolCallId = `anonymous-${++this.anonymousToolCallCounter}`;
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
    } else {
      message.blocks[index] = block;
    }
  }

  /**
   * Emits the final state of the current assistant message.
   * Called at agent_end to ensure the browser has the complete message.
   */
  private flushCurrentAssistantMessage(sessionId: string) {
    const message = this.transcript.get(this.currentAssistantMessageId);
    if (message) {
      this.emit({ type: "message_upsert", sessionId, message });
    }
  }

  /**
   * Sends a lightweight session status event for the currently focused session.
   * Includes streaming state, pending message count, and pending approval count.
   */
  private sendStatus(emit: EmitEvent = this.emit) {
    const session = this.session;
    if (!session) return;
    emit({
      type: "status",
      sessionId: session.sessionId,
      isStreaming: session.isStreaming,
      pendingMessageCount: session.pendingMessageCount,
      pendingApprovalCount: this.uiContext?.pendingCount ?? 0,
    });
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
    const session = this.session;
    if (!session && required) throw new Error("Pi session is not initialized");
    return session;
  }

  /** Returns the SessionManager or throws if not set. */
  private requireSessionManager() {
    if (!this.sessionManager)
      throw new Error("Pi session manager is not initialized");
    return this.sessionManager;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Message / block normalization helpers
//
// These functions convert Pi SDK internal message representations into
// the browser-compatible UiMessage/UiBlock format used by the protocol.
// They handle multiple content shapes from different Pi SDK providers.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Converts Pi SDK message content into normalized UiBlock entries.
 *
 * Each message may contain mixed content types: text, thinking, tool_call,
 * and tool_result blocks. This function decomposes the raw content array
 * into a flat list of UiBlock objects with stable ids.
 */
export function normalizeMessages(messages: any[]): UiMessage[] {
  const normalized: UiMessage[] = [];
  let lastAssistant: UiMessage | undefined;

  messages.forEach((message, index) => {
    // Tool result messages are attached to the preceding assistant message.
    // If there is no preceding assistant message, create a synthetic one.
    if (isToolResultMessage(message)) {
      const target =
        lastAssistant ?? createSyntheticAssistantMessage(message, index);
      appendToolResultToMessage(target, message, index);
      if (!lastAssistant) {
        normalized.push(target);
        lastAssistant = target;
      }
      return;
    }

    // Regular message: determine id, role, and blocks once, then either push
    // a new message or merge assistant blocks into the current assistant turn.
    const messageId = message.id ?? `history-${index}`;
    const role = normalizeRole(message.role);
    const uiMessage: UiMessage = {
      id: messageId,
      role,
      blocks: normalizeContent(message.content ?? message, messageId),
      createdAt: message.createdAt ?? message.timestamp,
    };

    // Streaming presents consecutive Pi SDK assistant messages as one
    // browser-visible assistant turn. Mirror that shape when loading history
    // so reloads do not split a single turn into multiple assistant bubbles.
    if (role === "assistant") {
      if (lastAssistant) {
        lastAssistant.blocks.push(...uiMessage.blocks);
        return;
      }

      normalized.push(uiMessage);
      lastAssistant = uiMessage;
      return;
    }

    // User/system messages are turn boundaries. The next assistant message
    // should start a new browser-visible assistant turn.
    normalized.push(uiMessage);
    lastAssistant = undefined;
  });

  return normalized;
}

/** Checks if a message is a tool result (role = "toolResult" or "tool"). */
function isToolResultMessage(message: any) {
  return message?.role === "toolResult" || message?.role === "tool";
}

/** Creates a synthetic assistant message to host orphan tool results. */
function createSyntheticAssistantMessage(
  message: any,
  index: number,
): UiMessage {
  const messageId = `history-tool-host-${message.id ?? index}`;
  return {
    id: messageId,
    role: "assistant",
    blocks: [],
    createdAt: message.createdAt ?? message.timestamp,
  };
}

/**
 * Appends a tool_result block to an assistant message, creating a
 * matching tool_call block if one doesn't already exist.
 */
function appendToolResultToMessage(
  message: UiMessage,
  toolResult: any,
  index: number,
) {
  const toolCallId = extractToolCallId(toolResult) ?? `tool-${index}`;
  const toolName =
    toolResult.toolName ?? toolResult.name ?? toolResult.tool ?? "tool";
  const callBlockId = `${message.id}:tool:${toolCallId}:call`;
  const resultBlockId = `${message.id}:tool:${toolCallId}:result`;

  // Try to find an existing tool_call block to update.
  const existingCall = findToolCallBlock(message, toolCallId);

  if (existingCall) {
    existingCall.id = callBlockId;
    existingCall.toolName = existingCall.toolName || toolName;
    existingCall.input ??= extractToolInput(toolResult);
    existingCall.status = toolResult.isError ? "error" : "completed";
  } else {
    // No existing call block — create one.
    message.blocks.push({
      id: callBlockId,
      type: "tool_call",
      toolCallId,
      toolName,
      input: extractToolInput(toolResult),
      status: toolResult.isError ? "error" : "completed",
    });
  }

  // Create or update the result block.
  const resultBlock: UiBlock = {
    id: resultBlockId,
    type: "tool_result",
    toolCallId,
    content: normalizeToolResultContent(toolResult),
    isError: toolResult.isError ?? Boolean(toolResult.error),
  };
  const existingIndex = message.blocks.findIndex(
    (block) => block.id === resultBlockId,
  );
  if (existingIndex === -1) {
    message.blocks.push(resultBlock);
  } else {
    message.blocks[existingIndex] = resultBlock;
  }
}

/** Normalizes tool result content into a displayable string. */
function normalizeToolResultContent(toolResult: any) {
  const content =
    toolResult.content ??
    toolResult.result ??
    toolResult.output ??
    toolResult.error ??
    toolResult;
  return flattenText(content);
}

/** Maps Pi SDK role strings to the protocol's normalized role values. */
function normalizeRole(role: unknown): UiMessage["role"] {
  if (
    role === "user" ||
    role === "assistant" ||
    role === "tool" ||
    role === "system"
  )
    return role;
  if (role === "toolResult") return "tool";
  return "system";
}

/**
 * Converts Pi SDK message content into normalized UiBlock entries.
 *
 * Handles three content shapes:
 *   1. String content → single text block.
 *   2. Array of content parts → one UiBlock per recognized part.
 *   3. Unknown shape → JSON-serialized text block.
 */
function normalizeContent(content: unknown, messageId: string): UiBlock[] {
  if (typeof content === "string") {
    return [{ id: `${messageId}:text:0`, type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    const blocks = content
      .map((part, index) => normalizeContentPart(part, messageId, index))
      .filter(Boolean) as UiBlock[];
    // Ensure at least one block exists for display purposes.
    if (blocks.length === 0) {
      return [{ id: `${messageId}:text:0`, type: "text", text: "" }];
    }
    return blocks;
  }
  return [
    { id: `${messageId}:text:0`, type: "text", text: flattenText(content) },
  ];
}

/**
 * Converts a single content part into a UiBlock, or returns null for
 * unrecognized shapes.
 */
function normalizeContentPart(
  part: any,
  messageId: string,
  index: number,
): UiBlock | null {
  // Plain string part → text block.
  if (typeof part === "string") {
    return { id: `${messageId}:text:${index}`, type: "text", text: part };
  }

  const type = part?.type;

  if (type === "text") {
    return {
      id: part.id ?? `${messageId}:text:${index}`,
      type: "text",
      text: part.text ?? "",
    };
  }

  if (type === "thinking") {
    return {
      id: part.id ?? `${messageId}:thinking:${index}`,
      type: "thinking",
      text: part.thinking ?? part.text ?? "",
      collapsed: part.collapsed ?? true,
    };
  }

  // Handle both "tool_call" and "toolCall" for cross-provider compatibility.
  if (type === "tool_call" || type === "toolCall") {
    const toolCallId = extractToolCallId(part) ?? `tool-${index}`;
    return {
      id: `${messageId}:tool:${toolCallId}:call`,
      type: "tool_call",
      toolCallId,
      toolName: part.toolName ?? part.name ?? part.tool ?? "",
      input: extractToolInput(part),
      status: part.status ?? "completed",
    };
  }

  if (type === "tool_result" || type === "toolResult") {
    const toolCallId = extractToolCallId(part) ?? `tool-${index}`;
    return {
      id: `${messageId}:tool:${toolCallId}:result`,
      type: "tool_result",
      toolCallId,
      content:
        typeof part.content === "string"
          ? part.content
          : flattenText(part.content),
      isError: part.isError ?? false,
    };
  }

  // Fallback: if the part has a text property, treat it as text.
  if (part?.text) {
    return {
      id: part.id ?? `${messageId}:text:${index}`,
      type: "text",
      text: part.text,
    };
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Utility helpers exported for use by pi-session-workspace and other modules
// ──────────────────────────────────────────────────────────────────────────

/**
 * Extracts a tool call id from any value by probing known field names.
 * Pi SDK events and messages from different providers use different field
 * shapes — this function checks them all.
 */
export function extractToolCallId(value: any): string | undefined {
  const id =
    value?.toolCallId ??
    value?.tool_call_id ??
    value?.callID ??
    value?.callId ??
    value?.toolUseId ??
    value?.tool_use_id ??
    value?.toolCall?.id ??
    value?.toolCall?.toolCallId ??
    value?.call?.id ??
    value?.execution?.toolCallId ??
    value?.execution?.id ??
    value?.id;
  return id === undefined || id === null || id === "" ? undefined : String(id);
}

/**
 * Extracts tool input/arguments from any value by probing known field names.
 */
export function extractToolInput(value: any): unknown {
  return (
    value?.input ??
    value?.args ??
    value?.params ??
    value?.arguments ??
    value?.toolInput ??
    value?.toolCall?.arguments
  );
}

/** Finds a tool_call block within a message by toolCallId. */
export function findToolCallBlock(message: UiMessage, toolCallId: string) {
  return message.blocks.find(
    (block): block is Extract<UiBlock, { type: "tool_call" }> =>
      block.type === "tool_call" && block.toolCallId === toolCallId,
  );
}

/** Checks whether two UiBlocks represent the same logical tool entry. */
export function areSameToolBlock(left: UiBlock, right: UiBlock) {
  if (left.type === "tool_call" && right.type === "tool_call")
    return left.toolCallId === right.toolCallId;
  if (left.type === "tool_result" && right.type === "tool_result")
    return left.toolCallId === right.toolCallId;
  return false;
}

/**
 * Flattens arbitrary content into a displayable string.
 * Recursively joins array elements and stringifies objects.
 */
export function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("");
  }
  return JSON.stringify(content);
}

/** Converts ImagePayload to Pi SDK image format (base64 media). */
export function toPiImages(images?: ImagePayload[]): any[] | undefined {
  return images?.map((image) => ({
    type: "image",
    source: {
      type: "base64",
      mediaType: image.mediaType,
      data: image.data,
    },
  }));
}

/** Converts Pi SDK session info to the UI session summary format. */
export function toUiSessionSummary(info: any): UiSessionSummary {
  return {
    file: info.path ?? info.file ?? info.sessionFile,
    sessionId: info.id ?? info.sessionId,
    name: info.name,
    createdAt: toTimestamp(info.created ?? info.createdAt),
    updatedAt: toTimestamp(info.modified ?? info.updatedAt ?? info.mtimeMs),
    firstMessage: info.firstMessage ?? info.preview,
  };
}

/** Converts Pi SDK model info to the UI model format. */
export function toUiModel(model: any): UiModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    availableThinkingLevels: supportedThinkingLevels(model),
  };
}

/** Normalizes a thinking level value, defaulting to "off" for unknown values. */
export function normalizeThinkingLevel(level: unknown): ThinkingLevel {
  return DEFAULT_THINKING_LEVELS.includes(level as ThinkingLevel)
    ? (level as ThinkingLevel)
    : "off";
}

/** Returns supported thinking levels for a model based on its reasoning capability. */
export function supportedThinkingLevels(model: any): ThinkingLevel[] {
  if (!model?.reasoning) return ["off"];
  return DEFAULT_THINKING_LEVELS.filter((level) => {
    // If the model has a thinkingLevelMap, check if this level is mapped.
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    // "xhigh" requires an explicit mapping.
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}

/** Extracts session metadata from a SessionManager for UI display. */
export function summarizeSessionManager(
  sessionManager: SessionManager,
): Omit<UiSessionSummary, "file"> {
  const header = sessionManager.getHeader();
  const entries = sessionManager.getEntries();
  const latestEntry = entries.at(-1);
  return {
    name: sessionManager.getSessionName(),
    createdAt: toTimestamp(header?.timestamp),
    updatedAt: toTimestamp(latestEntry?.timestamp ?? header?.timestamp),
    firstMessage: firstUserMessage(entries),
  };
}

/** Finds the text of the first user message in session entries. */
export function firstUserMessage(entries: any[]) {
  for (const entry of entries) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "user") continue;
    const text = flattenText(message.content);
    if (text) return text;
  }
  return undefined;
}

/** Converts a timestamp-like value to a numeric epoch milliseconds. */
export function toTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? undefined : timestamp;
  }
  return undefined;
}

/** Summarizes tool result content for display, truncating at 500 characters. */
export function summarizeToolResult(result: unknown) {
  const text = flattenText(result);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}
