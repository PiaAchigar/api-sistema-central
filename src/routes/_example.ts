import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createDb } from "../db/client";
import type { AppBindings } from "../env";

const db = new Hono<{ Bindings: AppBindings }>();

db.get("/", async (c) => {
  const drizzleDb = createDb(c.env);
  const result = await drizzleDb.execute(sql`select now() as now`);
  return c.json({ result });
});

export { db };
