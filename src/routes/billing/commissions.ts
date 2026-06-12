import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { getCommissionsReport } from "../../services/commissions.service";
import type { AppBindings } from "../../env";

const commissionsRouter = new Hono<{ Bindings: AppBindings }>();

const query = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  providerId: z.string().uuid().optional(),
});

commissionsRouter.get("/", zValidator("query", query), async (c) => {
  const db = createDb(c.env);
  const { from, to, providerId } = c.req.valid("query");
  return c.json(await getCommissionsReport(db, from, to, providerId));
});

export { commissionsRouter };
