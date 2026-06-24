import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { auth, requireAuth } from "../../middleware/auth";
import {
  getTrainingById,
  listTrainings,
  updateTrainingWebSettings,
} from "../../repositories/trainings.repo";
import type { AppBindings } from "../../env";

const trainings = new Hono<{ Bindings: AppBindings }>();

const listQuery = z.object({
  featured: z.string().optional().transform((v) => v === "true"),
});

function serializePrices<T extends { listPrice: string | null; cashPrice: string | null }>(r: T) {
  return {
    ...r,
    listPrice: r.listPrice != null ? Number(r.listPrice) : null,
    cashPrice: r.cashPrice != null ? Number(r.cashPrice) : null,
  };
}

trainings.get("/", zValidator("query", listQuery), async (c) => {
  const db = createDb(c.env);
  const filters = c.req.valid("query");
  const rows = await listTrainings(db, { featured: filters.featured });
  return c.json(rows.map(serializePrices));
});

trainings.get("/:id", async (c) => {
  const db = createDb(c.env);
  const row = await getTrainingById(db, c.req.param("id"));
  if (!row) return c.json({ error: "Training not found" }, 404);
  return c.json(serializePrices(row));
});

const patchBody = z
  .object({
    isFeatured: z.boolean().optional(),
    webSortOrder: z.number().int().min(0).optional(),
  })
  .refine(
    (data) => data.isFeatured !== undefined || data.webSortOrder !== undefined,
    { message: "At least one field (isFeatured or webSortOrder) is required" },
  );

trainings.patch("/:id", auth, requireAuth, zValidator("json", patchBody), async (c) => {
  const db = createDb(c.env);
  const id = c.req.param("id");
  const updated = await updateTrainingWebSettings(db, id, c.req.valid("json"));
  if (!updated) return c.json({ error: "Training not found" }, 404);
  return c.json(updated);
});

export { trainings };
