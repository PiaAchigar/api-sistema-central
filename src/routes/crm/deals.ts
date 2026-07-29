// api-sistema-central/src/routes/crm/deals.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { badRequest, notFound } from "../../lib/errors";
import { requireAuth, requirePermission } from "../../middleware/auth";
import {
  assignDeal,
  cancelDeal,
  createDeal,
  getDealById,
  listDealsForPipeline,
  updateDealStage,
  updateDealTitle,
} from "../../repositories/deals.repo";
import { getAppointmentById } from "../../repositories/appointments.repo";
import { creditCustomer, getCustomerByContactId } from "../../repositories/customers.repo";
import { listActiveLocalUsers } from "../../repositories/users.repo";
import { runAutomations } from "../../services/automation.service";
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
      title: z.string().min(1).optional(),
      stage: z.enum(STAGES).optional(),
      assignedAgentId: z.string().uuid().nullable().optional(),
    }),
  ),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const body = c.req.valid("json");
    let updated = null;
    if (body.title) updated = await updateDealTitle(db, id, body.title);
    if (body.stage) updated = await updateDealStage(db, id, body.stage);
    if (body.assignedAgentId !== undefined) {
      updated = await assignDeal(db, id, body.assignedAgentId);
    }
    if (!updated) throw notFound("Deal");
    if (body.stage) {
      await runAutomations(db, {
        type: "deal_stage_changed",
        dealId: id,
        contactId: updated.contactId,
        toStage: body.stage,
      });
    }
    return c.json(updated);
  },
);

dealsRouter.patch(
  "/:id/cancel",
  requireAuth,
  requirePermission("crm", "edit"),
  // `deals.cancel_reason` es VARCHAR(255) en la base — el max acá evita que un
  // motivo largo explote como error crudo de Postgres en vez de un 400 limpio.
  zValidator("json", z.object({ cancelReason: z.string().min(1).max(255) })),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const { cancelReason } = c.req.valid("json");

    // Distinguir "no existe" (404) de "ya está cancelado" (no-op, 200) —
    // cancelar dos veces no es un error. `cancelDeal` ahora es condicional
    // (WHERE cancelled IS NOT TRUE) para blindar contra carreras, así que un
    // segundo llamado devuelve `null` aunque el deal exista.
    const existing = await getDealById(db, id);
    if (!existing) throw notFound("Deal");
    if (existing.cancelled) return c.json(existing);

    // Si el deal está atado a un turno que sigue vivo, cancelarlo desde el
    // kanban acreditaría la seña mientras el local sigue reservando el horario
    // (doble conteo). La cancelación tiene que salir de la agenda, que además
    // libera el turno y acredita el saldo en una sola transacción.
    if (existing.appointmentId) {
      const appt = await getAppointmentById(db, existing.appointmentId);
      if (appt && appt.status !== "cancelled") {
        throw badRequest(
          "Este deal está vinculado a un turno activo — cancelá el turno desde la agenda primero.",
        );
      }
    }

    const cancelled = await db.transaction(async (tx) => {
      const deal = await cancelDeal(tx, id, { cancelReason });
      if (!deal) return null;
      if (deal.seniaPaid && deal.seniaAmount) {
        const customer = await getCustomerByContactId(tx, deal.contactId!);
        if (customer) await creditCustomer(tx, customer.id, Number(deal.seniaAmount));
      }
      return deal;
    });

    if (cancelled) return c.json(cancelled);

    // Carrera: se canceló entre nuestro check y la transacción. El deal
    // existe y ya está cancelado — no es un 404.
    const current = await getDealById(db, id);
    if (!current) throw notFound("Deal");
    return c.json(current);
  },
);

export { dealsRouter };
