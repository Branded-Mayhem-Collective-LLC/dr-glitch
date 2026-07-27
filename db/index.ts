import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DATABASE) {
    throw new Error(
      "Cloudflare D1 binding `DATABASE` is unavailable. Add a `d1_databases` binding named `DATABASE` to wrangler.toml or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DATABASE, { schema });
}
