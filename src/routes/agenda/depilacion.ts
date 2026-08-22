import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { auth, requireAuth, requirePermission } from "../../middleware/auth";
import {
  actualizarZona,
  crearZona,
  existeZonaActivaConNombre,
  guardarConfig,
  guardarExclusiones,
  leerConfig,
  listarZonas,
  setEstadoZona,
} from "../../repositories/depilacion.repo";
import type { AppBindings, Variables } from "../../env";

const depilacionRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

/**
 * Schemas Zod con mensajes en castellano: llegan tal cual a la pantalla, el
 * front los desarma y muestra "campo: mensaje" (mismo criterio que
 * `comboBody` en combos.ts).
 */

export const zonaBody = z.object({
  name: z
    .string()
    .min(1, "El nombre es obligatorio")
    .max(100, "El nombre no puede superar los 100 caracteres"),
  category: z.enum(["grande", "mediana", "chica"], {
    errorMap: () => ({ message: "La categoría tiene que ser grande, mediana o chica" }),
  }),
  displayOrder: z
    .number({ invalid_type_error: "El orden tiene que ser un número" })
    .int("El orden tiene que ser un número entero")
    .nonnegative("El orden no puede ser negativo")
    .nullish(),
});

export const estadoBody = z.object({
  isActive: z.boolean({ invalid_type_error: "El estado tiene que ser true o false" }),
});

export const exclusionesBody = z
  .object({
    excludes: z.array(z.string().uuid({ message: "La zona no es válida" })),
  })
  .superRefine((v, ctx) => {
    // El UNIQUE (zone_id, excludes_zone_id) de la base convertiría un
    // duplicado en un 500 en vez de un mensaje entendible.
    const vistos = new Set<string>();
    for (const id of v.excludes) {
      if (vistos.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["excludes"],
          message: "Hay una zona repetida en las exclusiones",
        });
        return;
      }
      vistos.add(id);
    }
  });

const enteroPositivo = (etiqueta: string) =>
  z
    .number({ invalid_type_error: `${etiqueta} tiene que ser un número` })
    .int(`${etiqueta} tiene que ser un número entero`)
    .positive(`${etiqueta} tiene que ser mayor a cero`);

export const configBody = z.object({
  priceGrande: enteroPositivo("El precio de zona grande"),
  priceMediana: enteroPositivo("El precio de zona mediana"),
  priceChica: enteroPositivo("El precio de zona chica"),
  pricingMinutesGrande: enteroPositivo("Los minutos de precio de zona grande"),
  pricingMinutesMediana: enteroPositivo("Los minutos de precio de zona mediana"),
  pricingMinutesChica: enteroPositivo("Los minutos de precio de zona chica"),
  tier1RatePerMinute: enteroPositivo("La tarifa del primer escalón"),
  tier2RatePerMinute: enteroPositivo("La tarifa del segundo escalón"),
  slotMinutesFemaleGrande: enteroPositivo("Los minutos de turno (mujer, grande)"),
  slotMinutesFemaleMediana: enteroPositivo("Los minutos de turno (mujer, mediana)"),
  slotMinutesFemaleChica: enteroPositivo("Los minutos de turno (mujer, chica)"),
  slotMinutesMaleGrande: enteroPositivo("Los minutos de turno (hombre, grande)"),
  slotMinutesMaleMediana: enteroPositivo("Los minutos de turno (hombre, mediana)"),
  slotMinutesMaleChica: enteroPositivo("Los minutos de turno (hombre, chica)"),
  slotRoundingStep: enteroPositivo("El redondeo del turno"),
  slotMinimumMinutes: enteroPositivo("El turno mínimo"),
  packSessions: enteroPositivo("Las sesiones del pack"),
  packDiscountPercentage: z
    .number({ invalid_type_error: "El descuento del pack tiene que ser un número" })
    .int("El descuento del pack tiene que ser un número entero")
    .min(0, "El descuento del pack no puede ser negativo")
    .max(100, "El descuento del pack no puede superar el 100%"),
  packRoundingBase: enteroPositivo("El redondeo del pack"),
});

// ── Zonas ────────────────────────────────────────────────────────────────

depilacionRouter.get(
  "/zonas",
  auth,
  requireAuth,
  requirePermission("catalogo", "view"),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await listarZonas(db));
  },
);

depilacionRouter.post(
  "/zonas",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", zonaBody),
  async (c) => {
    const db = createDb(c.env);
    const body = c.req.valid("json");
    if (await existeZonaActivaConNombre(db, body.name)) {
      throw conflict(`Ya existe una zona activa llamada "${body.name}"`);
    }
    const created = await crearZona(db, body);
    return c.json(created, 201);
  },
);

depilacionRouter.patch(
  "/zonas/:id",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", zonaBody),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const body = c.req.valid("json");
    if (await existeZonaActivaConNombre(db, body.name, id)) {
      throw conflict(`Ya existe una zona activa llamada "${body.name}"`);
    }
    const updated = await actualizarZona(db, id, body);
    if (!updated) throw notFound("Zona");
    return c.json(updated);
  },
);

depilacionRouter.patch(
  "/zonas/:id/estado",
  auth,
  requireAuth,
  requirePermission("catalogo", "manage"),
  zValidator("json", estadoBody),
  async (c) => {
    const db = createDb(c.env);
    const { isActive } = c.req.valid("json");
    const updated = await setEstadoZona(db, c.req.param("id"), isActive);
    if (!updated) throw notFound("Zona");
    return c.json(updated);
  },
);

depilacionRouter.put(
  "/zonas/:id/exclusiones",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", exclusionesBody),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const { excludes } = c.req.valid("json");
    if (excludes.includes(id)) throw badRequest("Una zona no puede excluirse a sí misma");
    await guardarExclusiones(db, id, excludes);
    return c.json({ zoneId: id, excludes });
  },
);

// ── Config ───────────────────────────────────────────────────────────────

depilacionRouter.get(
  "/config",
  auth,
  requireAuth,
  requirePermission("catalogo", "view"),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await leerConfig(db));
  },
);

depilacionRouter.put(
  "/config",
  auth,
  requireAuth,
  requirePermission("catalogo", "manage"),
  zValidator("json", configBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await guardarConfig(db, c.req.valid("json"));
    return c.json(updated);
  },
);

export { depilacionRouter };
