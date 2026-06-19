import { Hono } from "hono";
import { createDb } from "../../db/client";
import { listActivePromotions } from "../../repositories/promotions.repo";
import type { AppBindings } from "../../env";

const promotionsRouter = new Hono<{ Bindings: AppBindings }>();

promotionsRouter.get("/", async (c) => {
  const db = createDb(c.env);
  const promos = await listActivePromotions(db);
  return c.json(promos);
});

export { promotionsRouter };
