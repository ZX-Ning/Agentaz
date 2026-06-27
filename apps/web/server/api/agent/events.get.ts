import { createEventStream } from "h3";
import { getAgentRuntime } from "../../utils/agent-runtime";

/**
 * SSE streaming endpoint at GET /api/agent/events
 *
 * This is the sole realtime transport for the agent backend. Browser clients
 * connect here to receive server-pushed events over Server-Sent Events: state
 * snapshots, message streaming deltas, tool call updates, extension UI
 * prompts, and status changes. Browser-initiated actions use HTTP APIs — the
 * SSE stream is server-to-client events only.
 *
 * Headers:
 *   - Content-Type: text/event-stream
 *   - Cache-Control: no-cache
 *   - Connection: keep-alive
 *   - X-Accel-Buffering: no
 *
 * The endpoint is protected by the global auth middleware — the request
 * must carry a valid nuxt-auth-utils session cookie.
 *
 * Response:
 *   - 200 with an event stream containing serialised ServerEvent payloads.
 *   - The stream stays open until the browser closes it or the auth session
 *     expires (nuxt-auth-utils session is checked at connection time only).
 *
 * Lifecycle:
 *   - A fresh clientId is generated per connection.
 *   - createEventStream sets SSE headers and returns an EventStream.
 *   - The SseAgentHub registers the client and sends hello + snapshot.
 *   - Disconnect is detected via EventStream.onClosed and the hub
 *     cleans up presence state.
 */
export default defineEventHandler(async event => {
    const eventStream = createEventStream(event);

    const clientId = crypto.randomUUID();

    const hub = getAgentRuntime().hub;

    // Route owns h3 EventStream lifecycle; the hub owns runtime client state.
    eventStream.onClosed(() => hub.close(clientId));

    // Delegate presence attach, hello, snapshots, event subscription, and
    // heartbeat to the hub.
    await hub.open(clientId, data => {
        eventStream.push({ data });
    });

    // Hand control to h3 — headers are now written and the event stream
    // is piped to the HTTP response.
    return eventStream.send();
});
