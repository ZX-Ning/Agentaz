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
 * Process singleton event bus owned by AgentRuntime.
 * Decouples runtime publishers from SSE/state snapshot consumers.
 */
export class AgentEventBus {
    private handlers = new Set<AgentRuntimeEventHandler>();

    /**
     * Publishes one event to all current subscribers.
     *
     * Subscriber failures are isolated so a broken realtime transport or
     * projection listener cannot crash the Pi SDK workflow that emitted the
     * event, and cannot prevent later subscribers from seeing the same event.
     */
    publish(event: AgentRuntimeEvent) {
        for (const handler of this.handlers) {
            try {
                handler(event);
            } catch (error) {
                console.error(
                    "[agentaz-server] runtime event handler failed",
                    error,
                );
            }
        }
    }

    /** Subscribes to runtime events and returns a cleanup function. */
    subscribe(handler: AgentRuntimeEventHandler) {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }
}
