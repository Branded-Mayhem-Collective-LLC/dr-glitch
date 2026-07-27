import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

// No D1 binding is declared in wrangler.toml yet (Task 1 ships an
// unauthenticated SPA with no database). This ambient augmentation only
// satisfies the type checker for this pre-existing helper; Task 5 wires the
// real D1 binding into wrangler.toml and should replace this stub.
declare global {
  namespace Cloudflare {
    interface Env {
      DB?: D1Database;
    }
  }
}

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}
