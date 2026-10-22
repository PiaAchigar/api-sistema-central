import { Hono } from "hono";
import { createDb } from "../../db/client";
import { requireAuth } from "../../middleware/auth";
import { basePlanificador } from "../../repositories/planificador.repo";
import type { AppBindings, Variables } from "../../env";

const planificadorRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// La base del plan de una compra: sus sesiones libres en orden, la puerta de
// pago y los turnos que la clienta ya tiene (spec 2026-10-22-planificador-de-la-compra).
planificadorRouter.get("/:compraId", requireAuth, async (c) => {
  const compraId = c.req.param("compraId");
  // Un id que no es uuid no puede ser una compra: 404 y no un 500 de Postgres.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(compraId)) {
    return c.json({ error: "La compra no existe" }, 404);
  }
  const db = createDb(c.env);
  const base = await basePlanificador(db, compraId);
  if (!base) return c.json({ error: "La compra no existe" }, 404);
  return c.json(base);
});

export { planificadorRouter };
