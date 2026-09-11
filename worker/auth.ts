import type { D1Database, IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";

export type Bindings = Env & { BETTER_AUTH_SECRET?: string };

export function authOrigin(value: string): string {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("BETTER_AUTH_URL must be an HTTPS origin (HTTP loopback is allowed locally).");
  }
  return url.origin;
}

/**
 * Create a Better Auth instance.
 *
 * MUST be called once per request. A module-scope singleton holds a D1 write
 * lock while the next instance blocks on it, which surfaces as multi-second
 * hangs and phantom 503s. See docs/specs/2026-07-27-*.md section 8.
 */
export function createAuth(
  env?: Bindings,
  cf?: IncomingRequestCfProperties,
) {
  const db = env ? drizzle(env.DATABASE, { schema }) : ({} as never);
  const baseURL = env ? authOrigin(env.BETTER_AUTH_URL) : undefined;

  return betterAuth({
    baseURL,
    trustedOrigins: baseURL ? [baseURL] : [],
    secret: env?.BETTER_AUTH_SECRET,
    ...withCloudflare(
      {
        autoDetectIpAddress: false,
        geolocationTracking: false,
        cf: cf ?? {},
        d1: env ? { db, options: { usePlural: true } } : undefined,
      },
      {
        emailAndPassword: { enabled: true },
        advanced: {
          disableOriginCheck: false,
          disableCSRFCheck: false,
          ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
        },
        user: {
          additionalFields: {
            signupSource: { type: "string", required: false },
          },
        },
        rateLimit: {
          enabled: true,
          window: 60,
          max: 100,
          storage: "database",
        },
      },
    ),
    // Only needed so `@better-auth/cli generate` (which calls this factory
    // with no env) knows the target dialect for schema output. Runtime
    // requests always pass `env`, so `withCloudflare`'s `d1` config above is
    // what actually backs the database in production.
    ...(env
      ? {}
      : {
          database: drizzleAdapter({} as D1Database, {
            provider: "sqlite",
            usePlural: true,
          }),
        }),
  });
}
