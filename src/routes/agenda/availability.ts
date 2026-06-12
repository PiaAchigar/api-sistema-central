import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { getAvailability } from "../../services/availability.service";
import type { AppBindings } from "../../env";

const availability = new Hono<{ Bindings: AppBindings }>();

const query = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado: YYYY-MM-DD"),
  providerId: z.string().uuid().optional(),
});

availability.get("/:serviceId", zValidator("query", query), async (c) => {
  const db = createDb(c.env);
  const { date, providerId } = c.req.valid("query");
  const result = await getAvailability(db, c.req.param("serviceId"), date, providerId);
  return c.json(result);
});

export { availability };
