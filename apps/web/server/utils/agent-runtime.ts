import { AgentEventBus } from "./agent-event-bus";
import { ClientPresence, LOCAL_CLIENT_ID } from "./client-presence";
import {
  PiSessionWorkspace,
  type PiSessionWorkspaceOptions,
} from "./pi-session-workspace";
import { SessionProjector } from "./session-projector";
import { WsAgentHub } from "./ws-agent-hub";

/** Startup options shared by the process-wide agent runtime. */
export type AgentRuntimeOptions = {
  cwd: string;
  approvalTimeoutMs: number;
  maxLoadedSessions?: number;
};

/** Process-wide service graph for the local agent backend. */
export type AgentRuntime = {
  eventBus: AgentEventBus;
  presence: ClientPresence;
  workspace: PiSessionWorkspace;
  projector: SessionProjector;
  hub: WsAgentHub;
};

let runtime: AgentRuntime | undefined;
let runtimeOptions: PiSessionWorkspaceOptions | undefined;

/** Configures the process-wide agent runtime before it is used. */
export function configureAgentRuntime(options: AgentRuntimeOptions) {
  const normalized = {
    ...options,
    maxLoadedSessions: options.maxLoadedSessions ?? 5,
  };
  if (!runtimeOptions) {
    runtimeOptions = normalized;
    return;
  }

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

/** Returns the configured process-wide agent runtime singleton. */
export function getAgentRuntime() {
  if (!runtimeOptions) {
    throw new Error("AgentRuntime configuration has not been set.");
  }
  if (!runtime) {
    const eventBus = new AgentEventBus();
    const presence = new ClientPresence();
    const workspace = new PiSessionWorkspace(runtimeOptions, eventBus, () => {
      const protectedSessionIds = new Set<string>();
      for (const clientId of [LOCAL_CLIENT_ID, ...presence.clients()]) {
        const activeSessionId = presence.activeFor(clientId);
        if (activeSessionId) protectedSessionIds.add(activeSessionId);
      }
      return protectedSessionIds;
    });
    eventBus.subscribe((event) => {
      if (event.type !== "session_removed") return;
      presence.removeSession(event.sessionId, event.fallbackSessionId);
      eventBus.publish({ type: "state_changed" });
    });
    const projector = new SessionProjector(workspace, presence);
    const hub = new WsAgentHub(eventBus, presence, projector);
    runtime = { eventBus, presence, workspace, projector, hub };
  }
  return runtime;
}
