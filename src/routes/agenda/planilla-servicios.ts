import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { createDb } from "../../db/client";
import { AppError } from "../../lib/errors";
import { requireAuth, requirePermission } from "../../middleware/auth";
import {
  aplicarPlanilla,
  ErroresDePlanilla,
  leerPlanilla,
  previsualizarPlanilla,
} from "../../repositories/planilla-servicios.repo";
import type { AppBindings, Variables } from "../../env";

const planillaServiciosRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// Sólo admin y manager: la planilla toca el catálogo y los acuerdos con las proveedoras.
planillaServiciosRouter.use(
  "*",
  requireAuth,
  requirePermission("catalogo", "manage"),
  requirePermission("proveedoras", "manage"),
);

const celda = z.union([z.string(), z.number().finite(), z.null()]);
const fila = { fila: z.number().int() };

const contenidoSchema = z.object({
  servicios: z
    .array(
      z.object({
        ...fila,
        id: z.string().nullable(),
        nombre: celda, codigo: celda, descripcion: celda,
        precioLista: celda, precioEfectivo: celda, duracion: celda, unidad: celda,
        requiereOperadora: celda, requiereMaquina: celda, maquina: celda,
        visibleWeb: celda, destacado: celda, ordenWeb: celda,
        beneficios: celda, contraindicaciones: celda, instrucciones: celda,
      }),
    )
    .max(2000),
  acuerdos: z
    .array(z.object({ ...fila, servicio: celda, proveedora: celda, tipoDePago: celda, tarifa: celda }))
    .max(5000),
  insumos: z.array(z.object({ ...fila, servicio: celda, insumo: celda, cantidad: celda })).max(5000),
  categorias: z.array(z.object({ ...fila, servicio: celda, categoria: celda })).max(5000),
  // Opcional: las planillas viejas no tienen la pestaña Máquinas.
  maquinas: z.array(z.object({ ...fila, servicio: celda, maquina: celda })).max(5000).optional(),
});

const entradaSchema = z.object({
  area: z.string().min(1),
  original: contenidoSchema,
  editada: contenidoSchema,
});

const MSG_ARCHIVO = "El archivo no tiene el formato de la planilla. Bajá una nueva y completala.";

function errorDeArchivo(c: Context) {
  return c.json({ error: MSG_ARCHIVO, errores: [{ pestana: "Archivo", fila: null, mensaje: MSG_ARCHIVO }] }, 400);
}

/** Lee y valida el body; undefined si no es JSON o no respeta el contrato. */
async function leerEntrada(c: Context) {
  const crudo = await c.req.json().catch(() => undefined);
  const r = entradaSchema.safeParse(crudo);
  return r.success ? r.data : undefined;
}

function responderError(c: Context, err: unknown) {
  if (err instanceof ErroresDePlanilla) return c.json({ error: err.message, errores: err.errores }, 400);
  if (err instanceof AppError) return c.json({ error: err.message }, err.status);
  throw err;
}

/** GET /api/agenda/planilla-servicios?area= — datos del área para armar la planilla. */
planillaServiciosRouter.get("/", async (c) => {
  const area = c.req.query("area");
  if (!area) return c.json({ error: "Falta el área" }, 400);
  try {
    return c.json(await leerPlanilla(createDb(c.env), area));
  } catch (err) {
    return responderError(c, err);
  }
});

/** POST /previsualizar — 200 aunque haya errores: viajan en `errores`. */
planillaServiciosRouter.post("/previsualizar", async (c) => {
  const entrada = await leerEntrada(c);
  if (!entrada) return errorDeArchivo(c);
  try {
    return c.json(await previsualizarPlanilla(createDb(c.env), entrada));
  } catch (err) {
    return responderError(c, err);
  }
});

/** POST /aplicar — 400 `{ error, errores }` si la planilla tiene errores; no se guarda nada. */
planillaServiciosRouter.post("/aplicar", async (c) => {
  const entrada = await leerEntrada(c);
  if (!entrada) return errorDeArchivo(c);
  try {
    const resumen = await aplicarPlanilla(createDb(c.env), entrada, {
      id: c.get("userId"),
      email: c.get("userEmail"),
    });
    return c.json({ resumen });
  } catch (err) {
    return responderError(c, err);
  }
});

export { planillaServiciosRouter };
