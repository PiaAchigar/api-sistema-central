import { pgTable } from "drizzle-orm/pg-core";

export const _placeholder = pgTable("_placeholder", (t) => ({
  id: t.integer().primaryKey().generatedAlwaysAsIdentity(),
}));

export {};
