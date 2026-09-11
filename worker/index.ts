import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authOrigin, createAuth, type Bindings } from "./auth";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.use("/api/auth/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  if (!c.env.BETTER_AUTH_URL || !c.env.BETTER_AUTH_SECRET || c.env.BETTER_AUTH_SECRET.length < 32) {
    return c.json({ error: "Authentication is not configured." }, 503);
  }
  let origin: string;
  try { origin = authOrigin(c.env.BETTER_AUTH_URL); }
  catch { return c.json({ error: "Authentication is not configured." }, 503); }
  if (new URL(c.req.url).origin !== origin) return c.json({ error: "Untrusted request origin." }, 403);
  await next();
  // Upstream handlers install their own Response; set final headers afterward.
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
});
app.use("/api/auth/*", bodyLimit({ maxSize: 16 * 1024 }));
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  // D1 adapters and Cloudflare context belong to this request only.
  const auth = createAuth(c.env, c.req.raw.cf as IncomingRequestCfProperties | undefined);
  // Only static email/password endpoints are configured here. Reject unknown
  // paths before Better Auth creates a persistent per-IP/per-path limiter key.
  // Revisit when enabling password-reset delivery or OAuth parameterized routes.
  const path = new URL(c.req.url).pathname.slice("/api/auth".length);
  if (!Object.values(auth.api).some((endpoint) => "path" in endpoint && endpoint.path === path)) {
    return c.json({ error: "Not found." }, 404);
  }
  // Indexed, bounded cleanup also expires buckets belonging to departed IPs.
  await c.env.DATABASE.prepare(
    "DELETE FROM rate_limits WHERE id IN (SELECT id FROM rate_limits WHERE last_request < ? LIMIT 100)",
  ).bind(Date.now() - 10 * 60 * 1000).run();
  return auth.handler(c.req.raw);
});

export default app;
