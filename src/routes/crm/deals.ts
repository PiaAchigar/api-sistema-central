// api-sistema-central/src/routes/crm/deals.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { requireAuth, requirePermission } from "../../middleware/auth";
import {
  assignDeal,
  cancelDeal,
  createDeal,
  getOpenDealByContactId,
  listDealsForPipeline,
  updateDealStage,
} from "../../repositories/deals.repo";
import { creditCustomer, getCustomerById } from "../../repositories/customers.repo";
import { listActiveLocalUsers } from "../../repositories/users.repo";
import type { AppBindings, Variables } from "../../env";

const dealsRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

const STAGES = [
  "lead",
  "contactado",
  "presupuestado",
  "senia_pagada",
  "confirmado",
  "completado",
] as const;

dealsRouter.get("/", requireAuth, requirePermission("crm", "view"), async (c) => {
  const db = createDb(c.env);
  return c.json(await listDealsForPipeline(db));
});

dealsRouter.get("/agents", requireAuth, requirePermission("crm", "view"), async (c) => {
  const db = createDb(c.env);
  return c.json(await listActiveLocalUsers(db));
});

dealsRouter.post(
  "/",
  requireAuth,
  requirePermission("crm", "edit"),
  zValidator(
    "json",
    z.object({
      contactId: z.string().uuid(),
      title: z.string().min(1),
      serviceName: z.string().optional(),
      servicePrice: z.number().nonnegative().optional(),
    }),
  ),
  async (c) => {
    const db = createDb(c.env);
    const body = c.req.valid("json");
    const deal = await createDeal(db, {
      contactId: body.contactId,
      title: body.title,
      serviceName: body.serviceName ?? null,
      servicePrice: body.servicePrice?.toFixed(2) ?? null,
      stage: "lead",
    });
    return c.json(deal, 201);
  },
);

dealsRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("crm", "edit"),
  zValidator(
    "json",
    z.object({
      stage: z.enum(STAGES).optional(),
      assignedAgentId: z.string().uuid().nullable().optional(),
    }),
  ),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const body = c.req.valid("json");
    let updated = null;
    if (body.stage) updated = await updateDealStage(db, id, body.stage);
    if (body.assignedAgentId !== undefined) {
      updated = await assignDeal(db, id, body.assignedAgentId);
    }
    if (!updated) throw notFound("Deal");
    return c.json(updated);
  },
);

dealsRouter.patch(
  "/:id/cancel",
  requireAuth,
  requirePermission("crm", "edit"),
  zValidator("json", z.object({ cancelReason: z.string().min(1) })),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const { cancelReason } = c.req.valid("json");

    const cancelled = await db.transaction(async (tx) => {
      const deal = await cancelDeal(tx, id, { cancelReason });
      if (!deal) return null;
      if (deal.seniaPaid && deal.seniaAmount) {
        const customer = await getCustomerById(tx, deal.contactId!);
        if (customer) await creditCustomer(tx, customer.id, Number(deal.seniaAmount));
      }
      return deal;
    });

    if (!cancelled) throw notFound("Deal");
    return c.json(cancelled);
  },
);

export { dealsRouter };
