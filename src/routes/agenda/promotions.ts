import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { auth, requireAuth } from "../../middleware/auth";
import { listActivePromotions, updatePromotionFeatured } from "../../repositories/promotions.repo";
import type { AppBindings } from "../../env";

const promotionsRouter = new Hono<{ Bindings: AppBindings }>();

const listQuery = z.object({
  featured: z.string().optional().transform((v) => v === "true"),
});

promotionsRouter.get("/", zValidator("query", listQuery), async (c) => {
  const db = createDb(c.env);
  const { featured } = c.req.valid("query");
  const promos = await listActivePromotions(db, { featured });
  return c.json(promos);
});

const patchPromoBody = z.object({
  isFeatured: z.boolean(),
});

promotionsRouter.patch("/:id", auth, requireAuth, zValidator("json", patchPromoBody), async (c) => {
  const db = createDb(c.env);
  const id = c.req.param("id");
  const { isFeatured } = c.req.valid("json");
  const updated = await updatePromotionFeatured(db, id, isFeatured);
  if (!updated) return c.json({ error: "Promotion not found" }, 404);
  return c.json(updated);
});

export { promotionsRouter };
