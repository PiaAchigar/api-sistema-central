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

// Varias consultas de disponibilidad en un solo pedido (el planificador de la compra).
export const loteBody = z.object({
  consultas: z
    .array(
      z.object({
        serviceId: z.string().uuid(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado: YYYY-MM-DD"),
        durationMinutes: z.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(60),
});

availability.post("/lote", zValidator("json", loteBody), async (c) => {
  const db = createDb(c.env);
  const { consultas } = c.req.valid("json");
  const resultados = await Promise.all(
    consultas.map((q) =>
      // null (no undefined) = "usar la duración del servicio"; undefined dispara la búsqueda de reagendado.
      getAvailability(db, q.serviceId, q.date, undefined, undefined, q.durationMinutes ?? null),
    ),
  );
  return c.json({ resultados });
});

export { availability };
