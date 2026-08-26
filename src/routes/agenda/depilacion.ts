import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb, type Db } from "../../db/client";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { zv } from "../../lib/validator";
import { auth, requireAdmin, requireAuth, requirePermission } from "../../middleware/auth";
import { isForeignKeyViolation } from "../../lib/db-errors";
import {
  aConfigAnidada,
  actualizarCombo,
  actualizarZona,
  conflictoEnSeleccion,
  crearCombo,
  crearZona,
  exclusionesParaMotor,
  existeComboConNombre,
  existeZonaActivaConNombre,
  getComboDeleteImpact,
  getZonaDeleteImpact,
  guardarConfig,
  guardarExclusiones,
  hardDeleteCombo,
  hardDeleteZona,
  leerConfig,
  listarCombos,
  listarExclusiones,
  listarPacksFijos,
  listarZonas,
  obtenerCombo,
  obtenerKindYPrecioDeCombo,
  obtenerZona,
  obtenerZonasActivasPorId,
  setEstadoCombo,
  setEstadoZona,
  type ZonaRow,
} from "../../repositories/depilacion.repo";
import {
  buscarPackFijo,
  calcularDuracionTurno,
  calcularPrecioCombo,
  calcularPrecioPack,
  primeraViolacionNoInversion,
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
})
  .superRefine((v, ctx) => {
    // Ronda de fixes 1, punto 1 (Important): "agregar una zona nunca puede
    // bajar el precio" es la promesa central del negocio (PDF §1), y el test
    // que la protege en depilation-pricing.test.ts corre contra una config
    // CONGELADA en el archivo — no contra la que la dueña del negocio guarda
    // acá. Sin esto, un dígito de menos (ej. priceGrande: 1000 en vez de
    // 19000) se guardaba sin aviso y rompía la garantía en silencio.
    //
    // Capa 1, rápida: el orden grande >= mediana >= chica es una condición
    // necesaria (si una categoría "grande" vale menos que una "chica", cobrar
    // por posición ya no tiene sentido) y da un mensaje puntual sobre qué
    // campo mirar. No es suficiente por sí sola —la Capa 2 abajo cubre el
    // resto del espacio (tarifas de escalón demasiado altas, etc.)— así que
    // si el orden está bien igual se corre la Capa 2.
    if (v.priceGrande < v.priceMediana || v.priceMediana < v.priceChica) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["priceGrande"],
        message:
          "El precio de zona grande tiene que ser mayor o igual al de zona mediana, y el de zona " +
          "mediana mayor o igual al de zona chica. Si no, agregar una zona más grande a una " +
          "selección puede terminar costando MENOS que las zonas más chicas que ya estaban — y eso " +
          "nunca puede pasar.",
      });
      return;
    }

    // Capa 2, exhaustiva: corre la verificación de no-inversión de verdad
    // (el motor que ya existe, `primeraViolacionNoInversion`) sobre la
    // config que se está por guardar. Se mantiene sola si mañana cambia la
    // fórmula — no hay que acordarse de tocar esta validación a mano.
    const violacion = primeraViolacionNoInversion(aConfigAnidada(v));
    if (violacion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Con estos precios y tarifas, agregar una zona a una selección puede hacer que el total " +
          "termine costando IGUAL O MENOS que antes de agregarla — y agregar una zona nunca puede " +
          "bajar el precio. Revisá los precios de lista y las tarifas de escalón antes de guardar.",
      });
    }
  });

export const cotizarBody = z
  .object({
    zonaIds: z.array(z.string().uuid({ message: "Hay una zona que no es válida" })),
    sexo: z.enum(["mujer", "hombre"], {
      errorMap: () => ({ message: "El sexo tiene que ser mujer o hombre" }),
    }),
  })
  .superRefine((v, ctx) => {
    // Mandar la misma zona dos veces la cuenta dos veces (precio y
    // duración inflados sin aviso): mismo criterio que `comboDepilacionBody`
    // más abajo, que ya dedupe `zonaIds` por la misma razón.
    const vistos = new Set<string>();
    for (const id of v.zonaIds) {
      if (vistos.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["zonaIds"],
          message: "Hay una zona repetida en la selección",
        });
        return;
      }
      vistos.add(id);
    }
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
    // Pack propio del combo (migración 1.36.0). Los tres van juntos; el
    // superRefine de abajo exige que estén los tres o ninguno.
    packSessions: z
      .number({ invalid_type_error: "Las sesiones tienen que ser un número" })
      .int("Las sesiones tienen que ser un número entero")
      .positive("El pack tiene que tener al menos una sesión")
      .nullish(),
    packDiscountPercentage: z
      .number({ invalid_type_error: "El descuento tiene que ser un número" })
      .int("El descuento tiene que ser un número entero")
      .min(0, "El descuento no puede ser negativo")
      .max(100, "El descuento no puede pasar de 100")
      .nullish(),
    packRoundingBase: z
      .number({ invalid_type_error: "El redondeo tiene que ser un número" })
      .int("El redondeo tiene que ser un número entero")
      .positive("El redondeo tiene que ser mayor a cero")
      .nullish(),
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
    // "Zonas a elección" es un concepto de pack fijo (PDF §6 / diseño §4.7):
    // un guardado es una selección cerrada, sin nada por elegir después. El
    // CHECK de la base solo exige >= 0, no lo ata a `pack_fijo` — sin esto,
    // un guardado con choiceZoneCount > 0 le suma zonas fantasma "chica" a
    // su precioCalculado sin que tenga sentido.
    if (v.kind === "guardado" && v.choiceZoneCount != null && v.choiceZoneCount !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["choiceZoneCount"],
        message: "Un combo guardado no puede tener zonas a elección",
      });
    }
    // Las tres perillas del pack van juntas: media política obligaría a
    // inventar el número que falta. La base lo garantiza con
    // `ck_dc_pack_completo`, pero acá el mensaje se entiende.
    const packCargadas = [v.packSessions, v.packDiscountPercentage, v.packRoundingBase].filter(
      (x) => x != null,
    ).length;
    if (packCargadas > 0 && packCargadas < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["packSessions"],
        message:
          "El pack propio necesita las tres cosas: sesiones, descuento y redondeo. " +
          "Dejalas las tres vacías para usar el pack por defecto.",
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
  requirePermission("catalogo", "manage"),
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

// Impacto de un borrado real de zona: qué se va en cascada y si está
// bloqueado. Solo admin — es el paso previo al DELETE /zonas/:id/permanent.
depilacionRouter.get(
  "/zonas/:id/delete-impact",
  auth,
  requireAuth,
  requireAdmin,
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const zona = await obtenerZona(db, id);
    if (!zona) throw notFound("Zona");
    return c.json(await getZonaDeleteImpact(db, id));
  },
);

// Borrado real, irreversible. Distinto de PATCH /zonas/:id/estado, que
// archiva. Solo admin y solo si la zona no está en ningún combo.
depilacionRouter.delete(
  "/zonas/:id/permanent",
  auth,
  requireAuth,
  requireAdmin,
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const zona = await obtenerZona(db, id);
    if (!zona) throw notFound("Zona");

    const impacto = await getZonaDeleteImpact(db, id);
    if (impacto.blocked) throw badRequest(impacto.blockReason!);

    try {
      await hardDeleteZona(db, id);
    } catch (err) {
      // Entre el chequeo de impacto y el DELETE alguien pudo meter la zona en
      // un combo: la FK lo frena y el mensaje tiene que decir qué pasó, no
      // devolver un 500 opaco.
      if (isForeignKeyViolation(err)) {
        throw badRequest(
          "No se puede eliminar: apareció una referencia nueva justo ahora. Archivala en su lugar.",
        );
      }
      throw err;
    }
    return c.json({ ok: true });
  },
);

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

/**
 * Ronda de fixes 2, punto 2 (Important): `conflictoEnSeleccion` solo se
 * llamaba en `/cotizar` — POST/PATCH /combos solo chequeaban nombre repetido
 * y que las zonas existan y estén activas. Resultado: se podía guardar un
 * combo que después `/cotizar` rechazaba con 400 (un combo que existe y no
 * se puede cotizar). El camino es real, no teórico: el diseño deja a
 * propósito dos pares de exclusión sin sembrar (Brazos↔Antebrazo,
 * Espalda↔Hombros) para que se carguen después desde la pantalla de Zonas —
 * cuando eso pase, cualquier combo guardado con ese par queda inválido.
 *
 * Mismo `conflictoEnSeleccion` y mismo formato de error que usa `/cotizar`,
 * para que el mensaje sea consistente entre las dos pantallas.
 */
async function validarSinExclusionesEnConflicto(
  db: Db,
  zonaIds: string[],
  activas: Map<string, ZonaRow>,
): Promise<void> {
  const exclusiones = exclusionesParaMotor(await listarExclusiones(db));
  const conflicto = conflictoEnSeleccion(zonaIds, exclusiones);
  if (conflicto) {
    const nombreExcluyente = activas.get(conflicto.zonaId)?.name ?? conflicto.zonaId;
    const nombreExcluida = activas.get(conflicto.excluyeA)?.name ?? conflicto.excluyeA;
    throw badRequest(`"${nombreExcluyente}" y "${nombreExcluida}" no se pueden combinar`);
  }
}

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
  requirePermission("catalogo", "manage"),
  zv("json", comboDepilacionBody),
  async (c) => {
    const db = createDb(c.env);
    const body = c.req.valid("json");

    if (await existeComboConNombre(db, body.name)) {
      throw conflict(`Ya existe un combo llamado "${body.name}"`);
    }

    const activas = await obtenerZonasActivasPorId(db, body.zonaIds);
    const faltante = body.zonaIds.find((id) => !activas.has(id));
    if (faltante) throw badRequest(`La zona "${faltante}" no existe o no está activa`);
    await validarSinExclusionesEnConflicto(db, body.zonaIds, activas);

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

    // Ronda de fixes 2, punto 5 (Minor): una edición no puede cambiarle el
    // tipo a un combo existente ni, en consecuencia, borrarle el precio a un
    // pack fijo. El hook del front siempre manda `kind: "guardado"` sin
    // `fixedPrice` — sobre un pack fijo eso pasa el schema igual (un
    // "guardado" sin precio es válido en sí mismo) y silenciosamente lo
    // convertía en guardado, dejando `fixed_price = null`. Por la interfaz no
    // se llega (el botón Editar está oculto para los packs fijos), pero por
    // API un rol con solo `edit` sí podía destruir un pack sembrado.
    const existente = await obtenerKindYPrecioDeCombo(db, id);
    if (existente && existente.kind !== body.kind) {
      throw badRequest(
        "No se puede cambiar el tipo de un combo (pack fijo / guardado) editándolo — " +
          "archivalo y creá uno nuevo si necesitás el otro tipo.",
      );
    }
    // Defensa en profundidad: con el chequeo de arriba esto ya no debería
    // poder pasar (el kind no pudo cambiar, y el schema exige `fixedPrice`
    // en un `pack_fijo`), pero queda con su propio mensaje por si el día de
    // mañana esas dos reglas se desalinean.
    if (existente?.kind === "pack_fijo" && body.fixedPrice == null) {
      throw badRequest("No se puede borrar el precio fijo de un pack fijo.");
    }

    if (await existeComboConNombre(db, body.name, id)) {
      throw conflict(`Ya existe un combo llamado "${body.name}"`);
    }

    const activas = await obtenerZonasActivasPorId(db, body.zonaIds);
    const faltante = body.zonaIds.find((id) => !activas.has(id));
    if (faltante) throw badRequest(`La zona "${faltante}" no existe o no está activa`);
    await validarSinExclusionesEnConflicto(db, body.zonaIds, activas);

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


// Impacto de un borrado real de combo. Solo admin. Nunca queda bloqueado
// (nada referencia `depilation_combo` todavía); informa cuántas zonas se
// desvinculan para que la confirmación diga algo concreto.
depilacionRouter.get(
  "/combos/:id/delete-impact",
  auth,
  requireAuth,
  requireAdmin,
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const combo = await obtenerCombo(db, id);
    if (!combo) throw notFound("Combo");
    return c.json(await getComboDeleteImpact(db, id));
  },
);

// Borrado real, irreversible. Distinto de PATCH /combos/:id/estado, que archiva.
depilacionRouter.delete(
  "/combos/:id/permanent",
  auth,
  requireAuth,
  requireAdmin,
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const combo = await obtenerCombo(db, id);
    if (!combo) throw notFound("Combo");

    try {
      await hardDeleteCombo(db, id);
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw badRequest(
          "No se puede eliminar: apareció una referencia nueva justo ahora. Archivalo en su lugar.",
        );
      }
      throw err;
    }
    return c.json({ ok: true });
  },
);

export { depilacionRouter };
