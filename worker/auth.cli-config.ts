import { createAuth } from "./auth";

/**
 * CLI-only entry point for `@better-auth/cli generate`.
 *
 * The generator needs a module that exports a concrete `auth` instance (or a
 * default export) to introspect — it cannot call a factory. This file exists
 * solely so that instantiation happens somewhere `worker/index.ts` (the
 * actual runtime entry point) never imports. `createAuth()` called with no
 * arguments takes the `env === undefined` branch: no real D1 handle, no
 * secret, and the dummy `drizzleAdapter` in `worker/auth.ts` only tells the
 * generator which SQL dialect to emit. This instance is never used to serve
 * a request.
 *
 * Do not import this file from anywhere in the request path.
 */
export const auth = createAuth();
