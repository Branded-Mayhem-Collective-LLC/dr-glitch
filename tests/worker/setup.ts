import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      BETTER_AUTH_SECRET: string;
    }
  }
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS);
});
