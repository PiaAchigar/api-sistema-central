import { Hono } from "hono";
import { z } from "zod";
import { createDb } from "../../db/client";
import { AppError } from "../../lib/errors";
import { ajusteSchema } from "../../lib/ajuste-de-precios";
import { zv } from "../../lib/validator";
import { requireAuth, requirePermission } from "../../middleware/auth";
import {
  aplicarAjuste,
  ConflictoDePrecios,
  simularAjuste,
} from "../../repositories/ajuste-de-precios.repo";
import type { AppBindings, Variables } from "../../env";

const ajusteDePreciosRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// Actualizar precios en bloque toca el catálogo: mismo permiso que editar un servicio.
ajusteDePreciosRouter.use("*", requireAuth, requirePermission("catalogo", "edit"));

const simularSchema = z.object({
  categoryId: z.string().uuid({ message: "La categoría no es válida" }),
  ajuste: ajusteSchema,
});

const precioVisto = z.number().finite().nullable();

const aplicarSchema = simularSchema.extend({
  servicios: z
    .array(
      z.object({
        id: z.string().uuid({ message: "El servicio no es válido" }),
        listaVista: precioVisto,
        efectivoVista: precioVisto,
      }),
    )
    .min(1, "No hay servicios para ajustar"),
});

/** POST /api/agenda/precios/simular — calcula el antes/después sin escribir nada. */
ajusteDePreciosRouter.post("/simular", zv("json", simularSchema), async (c) => {
  const body = c.req.valid("json");
  const resultado = await simularAjuste(createDb(c.env), body);
  return c.json(resultado);
});

/** POST /api/agenda/precios/aplicar — 409 con `conflictos` si algún precio cambió desde la simulación. */
ajusteDePreciosRouter.post("/aplicar", zv("json", aplicarSchema), async (c) => {
  const body = c.req.valid("json");
  try {
    const resultado = await aplicarAjuste(createDb(c.env), {
      ...body,
      usuario: { id: c.get("userId"), email: c.get("userEmail") },
    });
    return c.json(resultado);
  } catch (err) {
    if (err instanceof ConflictoDePrecios) {
      return c.json({ error: err.message, conflictos: err.conflictos }, 409);
    }
    if (err instanceof AppError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

export { ajusteDePreciosRouter };
