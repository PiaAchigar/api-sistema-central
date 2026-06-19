import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import {
  createAppointment,
  listAppointmentsByDay,
  rescheduleAppointment,
  updateAppointmentStatus,
} from "../../services/appointments.service";
import type { AppBindings } from "../../env";

const appointmentsRouter = new Hono<{ Bindings: AppBindings }>();

const listQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  providerId: z.string().uuid().optional(),
  status: z.enum(["scheduled", "completed", "cancelled", "no_show"]).optional(),
});

appointmentsRouter.get("/", zValidator("query", listQuery), async (c) => {
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
});

appointmentsRouter.post("/", zValidator("json", createBody), async (c) => {
  const db = createDb(c.env);
  const appointment = await createAppointment(db, c.req.valid("json"));
  return c.json(appointment, 201);
});

const patchBody = z.object({
  status: z.enum(["reserved", "scheduled", "completed", "cancelled", "no_show"]).optional(),
  notes: z.string().max(1000).optional(),
});

appointmentsRouter.patch("/:id", zValidator("json", patchBody), async (c) => {
  const db = createDb(c.env);
  const updated = await updateAppointmentStatus(db, c.req.param("id"), c.req.valid("json"));
  return c.json(updated);
});

const rescheduleBody = z.object({
  newStart: z.string().datetime({ offset: true }),
});

appointmentsRouter.patch("/:id/reschedule", zValidator("json", rescheduleBody), async (c) => {
  const db      = createDb(c.env);
  const updated = await rescheduleAppointment(db, c.req.param("id"), c.req.valid("json").newStart);
  return c.json(updated);
});

export { appointmentsRouter };
