import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

// No D1 binding is declared in wrangler.toml yet (Task 1 ships an
// unauthenticated SPA with no database). This ambient augmentation only
// satisfies the type checker for this pre-existing helper.
//
// DELETE THIS ENTIRE `declare global` BLOCK AT TASK 5 — do not edit it in
// place. Once Task 5 adds a real D1 binding to wrangler.toml and runs
// `wrangler types`, the generated worker-configuration.d.ts will declare
// `interface Env { DB: D1Database }` (non-optional, since a declared binding
// is never undefined). TypeScript requires identical optionality across all
// merged declarations of an interface member, so leaving this stub's
// `DB?: D1Database` in place alongside the generated `DB: D1Database` fails
// with TS2687 ("All declarations of 'DB' must have identical modifiers").
// Changing `DB?` to `DB` here instead of deleting the block just duplicates
// the generated declaration — remove the whole block.
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
      "Cloudflare D1 binding `DB` is unavailable. Add a `d1_databases` binding named `DB` to wrangler.toml or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}
