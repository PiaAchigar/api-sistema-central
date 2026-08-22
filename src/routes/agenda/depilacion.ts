import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { zv } from "../../lib/validator";
import { auth, requireAuth, requirePermission } from "../../middleware/auth";
import {
  actualizarCombo,
  actualizarZona,
  conflictoEnSeleccion,
  crearCombo,
  crearZona,
  exclusionesParaMotor,
  existeZonaActivaConNombre,
  guardarConfig,
  guardarExclusiones,
  leerConfig,
  listarCombos,
  listarExclusiones,
  listarPacksFijos,
  listarZonas,
  obtenerZona,
  obtenerZonasActivasPorId,
  setEstadoCombo,
  setEstadoZona,
} from "../../repositories/depilacion.repo";
import {
  buscarPackFijo,
  calcularDuracionTurno,
  calcularPrecioCombo,
  calcularPrecioPack,
  type Categoria,
  type ZonaParaCotizar,
} from "../../lib/depilation-pricing";
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

export const cotizarBody = z.object({
  zonaIds: z.array(z.string().uuid({ message: "Hay una zona que no es válida" })),
  sexo: z.enum(["mujer", "hombre"], {
    errorMap: () => ({ message: "El sexo tiene que ser mujer o hombre" }),
  }),
});

/**
 * Validación del combo de depilación. Mensajes en castellano, mismo criterio
 * que `comboBody` en combos.ts: llegan tal cual a la pantalla.
 */
export const comboDepilacionBody = z
  .object({
    name: z
      .string()
      .min(1, "El nombre es obligatorio")
      .max(200, "El nombre no puede superar los 200 caracteres"),
    description: z
      .string()
      .max(2000, "La descripción no puede superar los 2000 caracteres")
      .nullish(),
    kind: z.enum(["pack_fijo", "guardado"], {
      errorMap: () => ({ message: "El tipo tiene que ser pack_fijo o guardado" }),
    }),
    fixedPrice: z
      .number({ invalid_type_error: "El precio tiene que ser un número" })
      .nonnegative("El precio no puede ser negativo")
      .nullish(),
    fixedDurationMinutes: z
      .number({ invalid_type_error: "La duración tiene que ser un número" })
      .int("La duración tiene que ser un número entero")
      .positive("La duración tiene que ser mayor a cero")
      .nullish(),
    choiceZoneCount: z
      .number({ invalid_type_error: "Las zonas a elección tienen que ser un número" })
      .int("Las zonas a elección tienen que ser un número entero")
      .nonnegative("Las zonas a elección no pueden ser negativas")
      .nullish(),
    isPublishedWeb: z.boolean().nullish(),
    displayOrder: z
      .number({ invalid_type_error: "El orden tiene que ser un número" })
      .int("El orden tiene que ser un número entero")
      .nonnegative("El orden no puede ser negativo")
      .nullish(),
    zonaIds: z
      .array(z.string().uuid({ message: "Hay una zona que no es válida" }))
      .min(1, "El combo tiene que incluir al menos una zona"),
  })
  .superRefine((v, ctx) => {
    // Un combo guardado no tiene precio propio (CHECK ck_dc_precio_guardado):
    // se cotiza siempre con la fórmula. Un pack fijo, al revés, necesita el
    // precio fijo cargado (CHECK ck_dc_precio_pack). Chequeado acá para dar
    // un mensaje entendible en vez de que la base lo rechace como 500.
    if (v.kind === "guardado" && v.fixedPrice != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixedPrice"],
        message: "Un combo guardado no lleva precio propio",
      });
    }
    if (v.kind === "pack_fijo" && v.fixedPrice == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixedPrice"],
        message: "Un pack fijo necesita el precio fijo",
      });
    }
    // La base tiene UNIQUE (combo_id, zone_id); si no se chequea acá, una
    // zona repetida rompe el INSERT como un 500 en vez de un mensaje claro.
    const vistos = new Set<string>();
    for (const id of v.zonaIds) {
      if (vistos.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["zonaIds"],
          message: "Hay una zona repetida en el combo",
        });
        return;
      }
      vistos.add(id);
    }
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
    const id = c.req.param("id");
    const { isActive } = c.req.valid("json");

    const zona = await obtenerZona(db, id);
    if (!zona) throw notFound("Zona");

    // Reactivar una zona archivada cuyo nombre ya lo tiene otra zona activa
    // choca contra `ux_body_zone_name` (único parcial WHERE is_active) y
    // sin este chequeo sale como 500 en vez del 409 amable que ya usan
    // POST y PATCH /zonas.
    if (isActive && (await existeZonaActivaConNombre(db, zona.name, id))) {
      throw conflict(`Ya existe una zona activa llamada "${zona.name}"`);
    }

    const updated = await setEstadoZona(db, id, isActive);
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

    // Sin esto: `:id` inexistente + excludes=[] respondía 200 sin haber
    // hecho nada (éxito falso), y un id inexistente en `excludes` rompía el
    // INSERT por FK como un 500 genérico en vez de un 400 entendible.
    const zona = await obtenerZona(db, id);
    if (!zona) throw notFound("Zona");

    if (excludes.length > 0) {
      const activas = await obtenerZonasActivasPorId(db, excludes);
      const faltante = excludes.find((zoneId) => !activas.has(zoneId));
      if (faltante) {
        throw badRequest(`La zona "${faltante}" no existe o no está activa`);
      }
    }

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

// ── Cotización ───────────────────────────────────────────────────────────

/**
 * El backend recalcula siempre: el front manda `zonaIds` y `sexo`, nunca un
 * precio. Orden: existencia/actividad de las zonas → exclusiones → config →
 * fórmula → pack fijo → duración → pack de sesiones.
 */
depilacionRouter.post(
  "/cotizar",
  auth,
  requireAuth,
  requirePermission("catalogo", "view"),
  zv("json", cotizarBody),
  async (c) => {
    const db = createDb(c.env);
    const { zonaIds, sexo } = c.req.valid("json");

    const activas = await obtenerZonasActivasPorId(db, zonaIds);
    const faltante = zonaIds.find((id) => !activas.has(id));
    if (faltante) throw badRequest(`La zona "${faltante}" no existe o no está activa`);

    const zonas: ZonaParaCotizar[] = zonaIds.map((id) => {
      const z = activas.get(id)!;
      return { id: z.id, nombre: z.name, categoria: z.category as Categoria };
    });

    const exclusiones = exclusionesParaMotor(await listarExclusiones(db));
    const conflicto = conflictoEnSeleccion(zonaIds, exclusiones);
    if (conflicto) {
      const nombreExcluyente = activas.get(conflicto.zonaId)?.name ?? conflicto.zonaId;
      const nombreExcluida = activas.get(conflicto.excluyeA)?.name ?? conflicto.excluyeA;
      throw badRequest(`"${nombreExcluyente}" y "${nombreExcluida}" no se pueden combinar`);
    }

    const config = await leerConfig(db);
    const { total: totalFormula, lineas } = calcularPrecioCombo(zonas, config);
    const packs = await listarPacksFijos(db);
    const packFijo = buscarPackFijo(zonaIds, packs);

    const total = packFijo ? packFijo.precioFijo : totalFormula;
    const duracionMinutos =
      packFijo?.duracionFija ?? calcularDuracionTurno(zonas, sexo, config);
    const packTotal = calcularPrecioPack(total, config);

    return c.json({
      total,
      lineas,
      duracionMinutos,
      pack: {
        sesiones: config.packSesiones,
        total: packTotal,
        ahorro: total * config.packSesiones - packTotal,
      },
      packFijo: packFijo
        ? {
            id: packFijo.id,
            nombre: packFijo.nombre,
            precio: packFijo.precioFijo,
            precioFormula: totalFormula,
          }
        : null,
    });
  },
);

// ── Combos ───────────────────────────────────────────────────────────────

depilacionRouter.get(
  "/combos",
  auth,
  requireAuth,
  requirePermission("catalogo", "view"),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await listarCombos(db));
  },
);

depilacionRouter.post(
  "/combos",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zv("json", comboDepilacionBody),
  async (c) => {
    const db = createDb(c.env);
    const body = c.req.valid("json");

    const activas = await obtenerZonasActivasPorId(db, body.zonaIds);
    const faltante = body.zonaIds.find((id) => !activas.has(id));
    if (faltante) throw badRequest(`La zona "${faltante}" no existe o no está activa`);

    const created = await crearCombo(db, body);
    return c.json(created, 201);
  },
);

depilacionRouter.patch(
  "/combos/:id",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zv("json", comboDepilacionBody),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const activas = await obtenerZonasActivasPorId(db, body.zonaIds);
    const faltante = body.zonaIds.find((id) => !activas.has(id));
    if (faltante) throw badRequest(`La zona "${faltante}" no existe o no está activa`);

    const updated = await actualizarCombo(db, id, body);
    if (!updated) throw notFound("Combo");
    return c.json(updated);
  },
);

depilacionRouter.patch(
  "/combos/:id/estado",
  auth,
  requireAuth,
  requirePermission("catalogo", "manage"),
  zValidator("json", estadoBody),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const { isActive } = c.req.valid("json");

    const updated = await setEstadoCombo(db, id, isActive);
    if (!updated) throw notFound("Combo");
    return c.json(updated);
  },
);

export { depilacionRouter };
