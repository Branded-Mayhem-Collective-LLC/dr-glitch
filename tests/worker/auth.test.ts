import { env } from "cloudflare:workers";
import { exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../../worker/index";
import type { Bindings } from "../../worker/auth";

const origin = "https://studio.example.test";
const password = "worker-test-password-only-123!";
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(origin + "/api/auth" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "cf-connecting-ip": "192.0.2.1", ...(body === undefined ? {} : {
      "content-type": "application/json", origin,
    }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function run(req: Request, overrides: Partial<Bindings> = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(req, { ...env, ...overrides }, context);
  await waitOnExecutionContext(context);
  return response;
}
async function signup() {
  const response = await run(request("/sign-up/email", { name: "Printer", email: "print@example.test", password }));
  expect(response.status, await response.clone().text()).toBe(200);
  const cookie = response.headers.get("set-cookie")!;
  return { response, cookie, sessionCookie: cookie.split(";")[0] };
}

describe("Worker auth with real local D1", () => {
  it("health works through the Worker entrypoint without auth configuration", async () => {
    expect(await (await exports.default.fetch(new Request(origin + "/api/health"))).json()).toEqual({ ok: true });
    expect((await run(new Request(origin + "/api/health"), { DATABASE: undefined as never, BETTER_AUTH_SECRET: undefined })).status).toBe(200);
  });

  it.each([
    { BETTER_AUTH_SECRET: undefined }, { BETTER_AUTH_SECRET: "short" },
    { BETTER_AUTH_URL: "" }, { BETTER_AUTH_URL: "http://public.example" },
    { BETTER_AUTH_URL: "https://studio.example.test/path" },
    { BETTER_AUTH_URL: "https://user:pass@studio.example.test" },
  ])("fails closed for invalid configuration %j", async (overrides) => {
    const response = await run(request("/get-session"), overrides);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("signs up, hashes passwords, authenticates, rejects tampering, and invalidates logout", async () => {
    const { response, cookie, sessionCookie } = await signup();
    for (const attribute of ["__Secure-better-auth.session_token=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(cookie).toContain(attribute);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const account = await env.DATABASE.prepare("SELECT password FROM accounts").first<{ password: string }>();
    expect(account?.password).toBeTruthy();
    expect(account?.password).not.toBe(password);
    const session = await run(request("/get-session", undefined, { cookie: sessionCookie }));
    expect(await session.json()).toMatchObject({ user: { email: "print@example.test" } });
    const forged = await run(request("/get-session", undefined, { cookie: sessionCookie + "tampered" }));
    expect(await forged.json()).toBeNull();
    expect((await run(request("/sign-out", {}, { cookie: sessionCookie }))).status).toBe(200);
    expect(await env.DATABASE.prepare("SELECT COUNT(*) AS count FROM sessions").first("count")).toBe(0);
    expect(await (await run(request("/get-session", undefined, { cookie: sessionCookie }))).json()).toBeNull();
    const login = await run(request("/sign-in/email", { email: "print@example.test", password }));
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("session_token=");
  });

  it("rejects host spoofing, cross-origin state changes, and external callbacks", async () => {
    expect((await run(new Request("https://evil.example/api/auth/get-session", {
      headers: { "x-forwarded-host": "studio.example.test", "x-forwarded-proto": "https" },
    }))).status).toBe(403);
    const { sessionCookie } = await signup();
    expect((await run(request("/sign-out", {}, { cookie: sessionCookie, origin: "https://evil.example" }))).status).toBe(403);
    expect(await env.DATABASE.prepare("SELECT COUNT(*) AS count FROM sessions").first("count")).toBe(1);
    expect((await run(request("/sign-up/email", {
      email: "other@example.test", name: "Other", password, callbackURL: "https://evil.example",
    }))).status).toBe(403);
  });

  it.each([false, true])("bounds oversized UTF-8 auth bodies (stream=%s)", async (streamed) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: "é".repeat(9000) }));
    const response = await run(new Request(origin + "/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: streamed ? new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) : bytes,
    }));
    expect(response.status).toBe(413);
    expect(await env.DATABASE.prepare("SELECT COUNT(*) AS count FROM users").first("count")).toBe(0);
  });

  it("shares rate limits across auth instances, ignores spoofed forwarded IPs, and expires stale keys", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await run(request("/sign-in/email", {}, { "x-forwarded-for": "198.51.100." + i, "x-real-ip": "198.51.100." + i }))).status).toBe(400);
    }
    const limited = await run(request("/sign-in/email", {}, { "x-forwarded-for": "203.0.113.4" }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("x-retry-after"))).toBeGreaterThan(0);
    expect((await run(request("/sign-in/email", {}, { "cf-connecting-ip": "192.0.2.2" }))).status).toBe(400);
    await env.DATABASE.prepare("UPDATE rate_limits SET last_request = ?").bind(Date.now() - 11 * 60 * 1000).run();
    expect((await run(request("/sign-in/email", {}))).status).toBe(400);
    expect(await env.DATABASE.prepare("SELECT COUNT(*) AS count FROM rate_limits").first("count")).toBe(1);
  });

  it("atomically admits only three concurrent sign-in attempts", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => run(request("/sign-in/email", {}))));
    expect(responses.map((r) => r.status).sort()).toEqual([400, 400, 400, 429, 429, 429]);
  });

  it("does not create limiter rows for arbitrary unknown paths", async () => {
    for (let i = 0; i < 5; i++) expect((await run(request("/unknown-" + i))).status).toBe(404);
    expect(await env.DATABASE.prepare("SELECT COUNT(*) AS count FROM rate_limits").first("count")).toBe(0);
  });

  it("bounds expired-key cleanup to 100 rows per request", async () => {
    await env.DATABASE.batch(Array.from({ length: 105 }, (_, index) =>
      env.DATABASE.prepare("INSERT INTO rate_limits (id, key, count, last_request) VALUES (?, ?, 1, ?)")
        .bind("expired-" + index, "expired-" + index, Date.now() - 11 * 60 * 1000)));
    expect((await run(request("/get-session"))).status).toBe(200);
    expect(await env.DATABASE.prepare("SELECT COUNT(*) AS count FROM rate_limits WHERE id LIKE 'expired-%'").first("count")).toBe(5);
  });
});
