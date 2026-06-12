import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { localDayRangeUtc, todayLocal } from "../../lib/time";
import { listPaymentsByRange } from "../../repositories/payments.repo";
import type { AppBindings } from "../../env";

const paymentsRouter = new Hono<{ Bindings: AppBindings }>();

const query = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  method: z.enum(["cash", "bank_transfer", "mercadopago"]).optional(),
});

paymentsRouter.get("/", zValidator("query", query), async (c) => {
  const db = createDb(c.env);
  const { date, method } = c.req.valid("query");
  const rows = await listPaymentsByRange(db, localDayRangeUtc(date ?? todayLocal()), { method });
  return c.json(rows.map((r) => ({ ...r, amount: r.amount != null ? Number(r.amount) : null })));
});

export { paymentsRouter };
