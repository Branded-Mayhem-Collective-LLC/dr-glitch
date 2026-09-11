import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";

// Shared D1 counters make Better Auth's atomic limiter work across isolates.
export const rateLimits = sqliteTable("rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
}, (table) => [index("rate_limits_last_request_idx").on(table.lastRequest)]);
