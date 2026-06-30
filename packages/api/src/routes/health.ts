import { Hono } from "@hono/hono";

export const healthRoutes = new Hono();

healthRoutes.get("/health", c => c.json({ ok: true, service: "pi-web-agent" }));
