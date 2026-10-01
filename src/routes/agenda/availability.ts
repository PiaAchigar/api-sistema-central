import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { getAvailability, getMonthAvailability } from "../../services/availability.service";
import type { AppBindings } from "../../env";

const availability = new Hono<{ Bindings: AppBindings }>();

export const availabilityQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado: YYYY-MM-DD"),
  providerId: z.string().uuid().optional(),
  // El turno que se está reagendando: su propio hueco cuenta como libre.
  excludeAppointmentId: z.string().uuid().optional(),
});

export const monthQuery = z.object({
  providerId: z.string().uuid({ message: "Falta la proveedora" }),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Formato esperado: YYYY-MM"),
  excludeAppointmentId: z.string().uuid().optional(),
});

availability.get("/:serviceId/month", zValidator("query", monthQuery), async (c) => {
  const db = createDb(c.env);
  const { providerId, month, excludeAppointmentId } = c.req.valid("query");
  const result = await getMonthAvailability(
    db,
    c.req.param("serviceId"),
    providerId,
    month,
    excludeAppointmentId,
  );
  return c.json(result);
});

availability.get("/:serviceId", zValidator("query", availabilityQuery), async (c) => {
  const db = createDb(c.env);
  const { date, providerId, excludeAppointmentId } = c.req.valid("query");
  const result = await getAvailability(
    db,
    c.req.param("serviceId"),
    date,
    providerId,
    excludeAppointmentId,
  );
  return c.json(result);
});

export { availability };
