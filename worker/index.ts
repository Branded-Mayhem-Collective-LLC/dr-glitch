import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { createAuth, type Bindings } from "./auth";

type Variables = { auth: ReturnType<typeof createAuth> };

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Per request. Never module scope.
app.use("*", async (c, next) => {
  // `@cloudflare/workers-types`' ambient `Request.cf` is typed as the looser
  // `CfProperties<unknown>` (it also covers non-incoming Requests), while
  // `createAuth` takes the stricter `IncomingRequestCfProperties` that
  // `withCloudflare` expects. At runtime, for the request Cloudflare hands
  // this Worker, the object genuinely has the stricter shape — this cast
  // just aligns the static type with that guarantee.
  c.set(
    "auth",
    createAuth(
      c.env,
      c.req.raw.cf as IncomingRequestCfProperties | undefined,
      new URL(c.req.url).origin,
    ),
  );
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.on(["GET", "POST"], "/api/auth/*", (c) => c.get("auth").handler(c.req.raw));

export default app;
