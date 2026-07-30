import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { resolveArcaConfig } from "../../arca/factory";
import { createDb } from "../../db/client";
import {
  computeProviderEarning,
  createAppointment,
  listAppointmentsByDay,
  rescheduleAppointment,
  updateAppointmentStatus,
} from "../../services/appointments.service";
import { getAppointmentById, getAppointmentDetail } from "../../repositories/appointments.repo";
import { getDealByAppointmentId } from "../../repositories/deals.repo";
import { requireAuth } from "../../middleware/auth";
import { notFound } from "../../lib/errors";
import type { AppBindings, Variables } from "../../env";

const appointmentsRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

const listQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  providerId: z.string().uuid().optional(),
  status: z.enum(["scheduled", "completed", "cancelled", "no_show"]).optional(),
});

appointmentsRouter.get("/", requireAuth, zValidator("query", listQuery), async (c) => {
  const db = createDb(c.env);
  const { date, ...filters } = c.req.valid("query");
  const rows = await listAppointmentsByDay(db, date, filters);
  return c.json(
    rows.map((r) => ({
      ...r,
      servicePrice: r.servicePrice != null ? Number(r.servicePrice) : null,
    })),
  );
});

appointmentsRouter.get("/:id", requireAuth, async (c) => {
  const db = createDb(c.env);
  const appt = await getAppointmentDetail(db, c.req.param("id"));
  if (!appt) throw notFound("Appointment");

  // Si todavía no se completó (y por lo tanto no hay comisión congelada), la
  // calculamos en vivo con el acuerdo actual solo para mostrarla — no se
  // persiste acá (eso lo hace el checkout al cobrar de verdad).
  let providerPaymentType = appt.providerPaymentType;
  let providerRate = appt.providerRate;
  let providerEarning = appt.providerEarning;
  let providerEarningIsPreview = false;
  if (providerEarning == null && appt.providerId && appt.serviceId) {
    const raw = await getAppointmentById(db, appt.id);
    const preview = raw ? await computeProviderEarning(db, raw) : {};
    if ("providerEarning" in preview) {
      providerPaymentType = preview.providerPaymentType ?? null;
      providerRate = preview.providerRate ?? null;
      providerEarning = preview.providerEarning ?? null;
      providerEarningIsPreview = true;
    }
  }

  // Seña a favor del cliente (si el turno se reservó con seña pagada)
  const deal = await getDealByAppointmentId(db, appt.id);
  const depositPaid =
    deal?.seniaPaid && deal.seniaAmount != null ? Number(deal.seniaAmount) : 0;

  return c.json({
    ...appt,
    servicePrice: appt.servicePrice != null ? Number(appt.servicePrice) : null,
    providerPaymentType,
    providerRate: providerRate != null ? Number(providerRate) : null,
    providerEarning: providerEarning != null ? Number(providerEarning) : null,
    providerEarningIsPreview,
    depositPaid,
  });
});

const createBody = z.object({
  customerId: z.string().uuid(),
  serviceId: z.string().uuid(),
  providerId: z.string().uuid(),
  machineId: z.string().uuid().optional(),
  start: z.string().datetime({ offset: true }),
  priceMode: z.enum(["list", "cash"]).optional(),
  notes: z.string().max(1000).optional(),
  status: z.enum(["scheduled", "reserved"]).optional(),
  expiryMinutes: z.number().int().min(5).max(480).optional(),
  deposit: z
    .object({
      amount: z.number().positive(),
      method: z.enum(["cash", "bank_transfer", "mercadopago"]),
      /** Facturador de la seña. Si no viene, el marcado por defecto. */
      issuerId: z.string().uuid().optional(),
    })
    .optional(),
});

appointmentsRouter.post("/", zValidator("json", createBody), async (c) => {
  const db = createDb(c.env);
  const input = c.req.valid("json");
  const arca = await resolveArcaConfig(db, c.env, input.deposit?.issuerId);
  const appointment = await createAppointment(db, input, arca);
  return c.json(appointment, 201);
});

const patchBody = z.object({
  status: z.enum(["reserved", "scheduled", "completed", "cancelled", "no_show"]).optional(),
  notes: z.string().max(1000).optional(),
});

appointmentsRouter.patch("/:id", requireAuth, zValidator("json", patchBody), async (c) => {
  const db = createDb(c.env);
  const updated = await updateAppointmentStatus(db, c.req.param("id"), c.req.valid("json"));
  return c.json(updated);
});

const rescheduleBody = z.object({
  newStart: z.string().datetime({ offset: true }),
});

appointmentsRouter.patch("/:id/reschedule", requireAuth, zValidator("json", rescheduleBody), async (c) => {
  const db      = createDb(c.env);
  const updated = await rescheduleAppointment(db, c.req.param("id"), c.req.valid("json").newStart);
  return c.json(updated);
});

export { appointmentsRouter };
