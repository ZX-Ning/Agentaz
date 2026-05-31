import { AgentEventBus } from "./agent-event-bus";
import { ClientPresence, LOCAL_CLIENT_ID } from "./client-presence";
import {
  PiSessionWorkspace,
  type PiSessionWorkspaceOptions,
} from "./pi-session-workspace";
import { SessionProjector } from "./session-projector";
import { SseAgentHub } from "./sse-agent-hub";

/**
 * Startup options shared by the process-wide agent runtime.
 *
 * These are set once by the Nitro startup plugin from runtime config
 * and cannot be changed after initialization.
 */
export type AgentRuntimeOptions = {
  /** Working directory for all Pi sessions. */
  cwd: string;
  /** Timeout in milliseconds for browser-backed extension UI approval prompts. */
  approvalTimeoutMs: number;
  /** Maximum number of Pi sessions that can be loaded simultaneously. */
  maxLoadedSessions?: number;
};

/**
 * Process-wide service graph for the local agent backend.
 *
 * Every service in the graph is a singleton scoped to the Node.js process.
 * There is no per-request or per-connection instantiation — all HTTP routes
 * and WebSocket handlers share the same instances via getAgentRuntime().
 */
export type AgentRuntime = {
  /** In-process pub/sub bus for session lifecycle and control events. */
  eventBus: AgentEventBus;
  /** Tracks browser client focus and session mutation control leases. */
  presence: ClientPresence;
  /** Owns Pi SDK services and the loaded session working set. */
  workspace: PiSessionWorkspace;
  /** Builds browser-facing state snapshots from runtime state. */
  projector: SessionProjector;
  /** Manages browser SSE connections and event forwarding. */
  hub: SseAgentHub;
};

/** Process-wide runtime singleton, initialized during Nitro startup. */
let runtime: AgentRuntime | undefined;

/**
 * Frozen snapshot of the options passed to configureAgentRuntime.
 * Used to detect misconfigured re-initialization attempts.
 */
let runtimeOptions: PiSessionWorkspaceOptions | undefined;

/**
 * Configures the process-wide agent runtime before any handler can use it.
 *
 * Must be called exactly once during Nitro startup (plugins/startup.ts).
 * Subsequent calls with the same options are idempotent (no-op).
 * Calls with different options throw — changing cwd, timeout, or session
 * limits mid-process would leave inconsistent state.
 *
 * @throws Error if called again with different options after the first call
 */
export function configureAgentRuntime(options: AgentRuntimeOptions) {
  const normalized = {
    ...options,
    maxLoadedSessions: options.maxLoadedSessions ?? 5,
  };

  // First call: store options for later lazy initialization.
  if (!runtimeOptions) {
    runtimeOptions = normalized;
    return;
  }

  // Subsequent calls with different options are a programming error.
  // The runtime singleton has already been wired or could be mid-use;
  // changing options would be unsafe.
  if (
    runtimeOptions.cwd !== normalized.cwd ||
    runtimeOptions.approvalTimeoutMs !== normalized.approvalTimeoutMs ||
    runtimeOptions.maxLoadedSessions !== normalized.maxLoadedSessions
  ) {
    throw new Error(
      "AgentRuntime configuration cannot be changed after it has been set.",
    );
  }
}

/**
 * Initializes the process-wide agent runtime singleton.
 *
 * Must be called exactly once during Nitro startup (plugins/startup.ts),
 * after configureAgentRuntime. Creates all services in dependency order:
 *
 *   1. AgentEventBus — must exist first so other services can subscribe.
 *   2. ClientPresence — independent of Pi SDK; tracks browser state.
 *   3. PiSessionWorkspace — the Pi SDK integration layer. Receives a callback
 *      that identifies sessions protected from eviction (any session currently
 *      focused by a connected browser client).
 *   4. SessionProjector — bridges workspace + presence into browser snapshots.
   *   5. SseAgentHub — manages SSE stream lifecycle on top of the event bus.
 *
 * After construction, the workspace is subscribed to session_removed events
 * from the event bus so ClientPresence stays in sync when sessions leave
 * the working set (e.g. evicted due to capacity).
 *
 * @throws Error if configureAgentRuntime has not been called first
 * @throws Error if the runtime has already been initialized
 */
export function initAgentRuntime() {
  if (!runtimeOptions) {
    throw new Error("AgentRuntime configuration has not been set.");
  }
  if (runtime) {
    throw new Error("AgentRuntime has already been initialized.");
  }

  // Phase 1: Create transport-independent services.
  const eventBus = new AgentEventBus();
  const presence = new ClientPresence();

  // Phase 2: Create the Pi SDK workspace. The getProtectedSessionIds
  // callback prevents eviction of sessions that a connected browser
  // client is currently focused on or controlling.
  const workspace = new PiSessionWorkspace(runtimeOptions, eventBus, () => {
    const protectedSessionIds = new Set<string>();
    for (const clientId of [LOCAL_CLIENT_ID, ...presence.clients()]) {
      const activeSessionId = presence.activeFor(clientId);
      if (activeSessionId) protectedSessionIds.add(activeSessionId);
    }
    return protectedSessionIds;
  });

  // Phase 3: Wire session_removed events → presence cleanup.
  // When the workspace evicts a session, remove it from presence tracking
  // so other services don't reference a stale session id.
  eventBus.subscribe((event) => {
    if (event.type !== "session_removed") return;
    presence.removeSession(event.sessionId, event.fallbackSessionId);
    eventBus.publish({ type: "state_changed" });
  });

  // Phase 4: Create browser-facing services on top of the core services.
  const projector = new SessionProjector(workspace, presence);
  const hub = new SseAgentHub(eventBus, presence, projector);

  runtime = { eventBus, presence, workspace, projector, hub };
}

/**
 * Returns the fully-initialized process-wide agent runtime singleton.
 *
 * initAgentRuntime() must have been called first (normally during Nitro
 * startup). This accessor is safe to call from any route or handler.
 *
 * @throws Error if initAgentRuntime has not been called first
 */
export function getAgentRuntime() {
  if (!runtime) {
    throw new Error("AgentRuntime has not been initialized. Call initAgentRuntime() first.");
  }
  return runtime;
}

/**
 * Disposes the process-wide runtime if it has been initialized.
 *
 * This is used by Nitro shutdown hooks. It deliberately does not call
 * getAgentRuntime(), because process teardown should not create Pi SDK services
 * just to dispose an app that never accepted an agent request.
 */
export async function disposeAgentRuntime() {
  if (!runtime) return;

  const currentRuntime = runtime;
  runtime = undefined;
  await currentRuntime.workspace.disposeAll();
}
