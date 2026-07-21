import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import {
  addManualCashMovement,
  getDailyReport,
  listCashMovements,
} from "../../services/cash.service";
import { todayLocal } from "../../lib/time";
import type { AppBindings } from "../../env";

const cashRouter = new Hono<{ Bindings: AppBindings }>();

const dateQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

cashRouter.get("/", zValidator("query", dateQuery), async (c) => {
  const db = createDb(c.env);
  const { date } = c.req.valid("query");
  const rows = await listCashMovements(db, date ?? todayLocal());
  return c.json(rows.map((r) => ({ ...r, amount: r.amount != null ? Number(r.amount) : null })));
});

const createBody = z.object({
  amount: z.number(),
  source: z.enum(["deposit", "refund", "other"]),
  description: z.string().min(1).max(500),
  isDeclared: z.boolean(),
});

cashRouter.post("/", zValidator("json", createBody), async (c) => {
  const db = createDb(c.env);
  const movement = await addManualCashMovement(db, c.req.valid("json"));
  return c.json(movement, 201);
});

cashRouter.get("/daily-report", zValidator("query", dateQuery), async (c) => {
  const db = createDb(c.env);
  const { date } = c.req.valid("query");
  const report = await getDailyReport(db, date ?? todayLocal());
  return c.json({
    ...report,
    payments: report.payments.map((p) => ({
      ...p,
      amount: p.amount != null ? Number(p.amount) : null,
      appointmentProviderEarning:
        p.appointmentProviderEarning != null ? Number(p.appointmentProviderEarning) : null,
    })),
    cashMovements: report.cashMovements.map((m) => ({
      ...m,
      amount: m.amount != null ? Number(m.amount) : null,
    })),
  });
});

export { cashRouter };
