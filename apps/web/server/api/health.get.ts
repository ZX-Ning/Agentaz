/**
 * GET /api/health
 *
 * Simple liveness check for the Pi Web Agent backend.
 * Returns a static JSON payload indicating the service is running.
 * Used by monitoring, load balancers, and the frontend to verify
 * the Nitro server is accepting requests before attempting agent operations.
 *
 * Response (200):
 *   { ok: true, service: "pi-web-agent" }
 *
 * This endpoint has no dependencies on the Pi SDK or agent runtime —
 * it responds as long as the Nitro HTTP server is alive.
 */
export default defineEventHandler(() => ({
    ok: true,
    service: "pi-web-agent",
}));
