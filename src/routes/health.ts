import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createDb } from "../db/client";
import type { AppBindings } from "../env";

const health = new Hono<{ Bindings: AppBindings }>();

health.get("/", async (c) => {
  const db = createDb(c.env);
  const startedAt = Date.now();

  try {
    const result = await db.execute<{ ok: number }>(sql`select 1 as ok`);
    const latencyMs = Date.now() - startedAt;
    return c.json({
      status: "ok",
      service: "piubella-worker",
      db: {
        status: "ok",
        latencyMs,
        result,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    return c.json(
      {
        status: "degraded",
        service: "piubella-worker",
        db: {
          status: "error",
          latencyMs,
          error: err instanceof Error ? err.message : String(err),
        },
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }
});

export { health };
