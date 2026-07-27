import type { D1Database, IncomingRequestCfProperties, R2Bucket } from "@cloudflare/workers-types";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";

export type Bindings = {
  ASSETS: Fetcher;
  DATABASE: D1Database;
  BUCKET: R2Bucket;
  BETTER_AUTH_SECRET: string;
};

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
  baseURL?: string,
) {
  const db = env ? drizzle(env.DATABASE, { schema }) : ({} as never);

  return betterAuth({
    baseURL,
    secret: env?.BETTER_AUTH_SECRET,
    ...withCloudflare(
      {
        autoDetectIpAddress: true,
        geolocationTracking: false,
        cf: cf ?? {},
        d1: env ? { db, options: { usePlural: true } } : undefined,
      },
      {
        emailAndPassword: { enabled: true },
        user: {
          additionalFields: {
            signupSource: { type: "string", required: false },
          },
        },
        rateLimit: {
          enabled: true,
          window: 60,
          max: 100,
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

// CLI-only instance: `@better-auth/cli generate` requires the config module
// to export an `auth` instance (or default export), not a factory. Never
// used at runtime — see `createAuth` above for the per-request instance.
export const auth = createAuth();
