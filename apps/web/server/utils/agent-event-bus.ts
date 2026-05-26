import type { ServerEvent } from "../../types/protocol";

/** Internal runtime events shared by session services and realtime transports. */
export type AgentRuntimeEvent =
  | { type: "server_event"; event: ServerEvent }
  | { type: "state_changed" }
  | { type: "session_removed"; sessionId: string; fallbackSessionId?: string }
  | {
      type: "control_changed";
      sessionId: string;
      controlOwnerClientId?: string;
    };

/** Receives one runtime event from the in-process agent event bus. */
export type AgentRuntimeEventHandler = (event: AgentRuntimeEvent) => void;

/**
 * Lightweight typed in-process event bus for the local agent runtime.
 *
 * Producers publish domain and protocol events without knowing whether any browser is connected.
 * Realtime transports subscribe and decide how to project or forward those events.
 */
export class AgentEventBus {
  private handlers = new Set<AgentRuntimeEventHandler>();

  /** Publishes one event to all current subscribers. */
  publish(event: AgentRuntimeEvent) {
    for (const handler of this.handlers) handler(event);
  }

  /** Subscribes to runtime events and returns a cleanup function. */
  subscribe(handler: AgentRuntimeEventHandler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
