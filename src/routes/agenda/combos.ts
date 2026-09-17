import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { auth, requireAuth, requirePermission } from "../../middleware/auth";
import {
  createCombo,
  deleteComboPermanently,
  duplicadosDe,
  getComboById,
  getComboDeleteImpact,
  listCombos,
  listPublicCombos,
  guardarTarifario,
  listarTarifarios,
  setComboStatus,
  updateCombo,
  validarPack,
} from "../../repositories/combos.repo";
import type { AppBindings, Variables } from "../../env";

const combosRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

/** Tope de sesiones por línea: 999 sobra para este negocio y evita que un
 *  número desmedido reviente el INSERT (int4 de Postgres) como un 500. */
const MAX_SESSIONS_INCLUDED = 999;

const lineSchema = z.object({
  serviceId: z.string().uuid({ message: "El servicio no es válido" }),
  // Opcional y con default 1 desde la 1.50.0 (spec §4.3): **un combo es UNA
  // sesión de cada servicio**. Repetir es trabajo de un pack, y tener dos
  // formas de armar lo mismo hacía imposible explicar por qué algo aparecía en
  // una solapa y no en la otra. Se deja aceptar el campo para no romper a quien
  // ya lo mandaba.
  sessionsIncluded: z
    .number({ invalid_type_error: "Las sesiones tienen que ser un número" })
    .int("Las sesiones tienen que ser un número entero")
    .min(1, "Cada servicio tiene que llevar al menos 1 sesión")
    .max(MAX_SESSIONS_INCLUDED, `Las sesiones no pueden superar ${MAX_SESSIONS_INCLUDED}`)
    .default(1),
});

/** Tope de repeticiones de un pack. Mismo criterio que `MAX_SESSIONS_INCLUDED`. */
const MAX_PACK_SESSIONS = 999;

/**
 * Validación del cuerpo. Los mensajes van en castellano porque llegan tal cual
 * a la pantalla: `textoDeError()` en el front desarma el ZodError y muestra
 * "campo: mensaje".
 */
export const comboBody = z
  .object({
    name: z
      .string()
      .min(1, "El nombre es obligatorio")
      .max(200, "El nombre no puede superar los 200 caracteres"),
    description: z
      .string()
      .max(2000, "La descripción no puede superar los 2000 caracteres")
      .nullish(),
    priceType: z.enum(["fixed", "percentage"], {
      errorMap: () => ({ message: "El tipo de precio tiene que ser fijo o por porcentaje" }),
    }),
    fixedPrice: z
      .number({ invalid_type_error: "El precio tiene que ser un número" })
      .nonnegative("El precio no puede ser negativo")
      .nullish(),
    discountPercentage: z
      .number({ invalid_type_error: "El porcentaje tiene que ser un número" })
      .min(0, "El porcentaje no puede ser negativo")
      .max(100, "El porcentaje no puede superar el 100%")
      .nullish(),
    validityMonths: z
      .number({ invalid_type_error: "La vigencia tiene que ser un número" })
      .int("La vigencia tiene que ser un número entero de meses")
      .min(1, "La vigencia tiene que ser de al menos 1 mes"),
    isVisibleWeb: z.boolean().nullish(),
    displayOrder: z
      .number({ invalid_type_error: "El orden tiene que ser un número" })
      .int("El orden tiene que ser un número entero")
      .nonnegative("El orden no puede ser negativo")
      .nullish(),
    // ── 1.50.0 ─────────────────────────────────────────────────────────────
    areaCategoryId: z.string().uuid({ message: "Hay que elegir un área" }),
    kind: z.enum(["combo", "pack"]).default("combo"),
    packOfComboId: z.string().uuid({ message: "El combo del pack no es válido" }).nullish(),
    packSessions: z
      .number({ invalid_type_error: "Las repeticiones tienen que ser un número" })
      .int("Las repeticiones tienen que ser un número entero")
      .min(2, "Un pack repite al menos 2 veces")
      .max(MAX_PACK_SESSIONS, `Las repeticiones no pueden superar ${MAX_PACK_SESSIONS}`)
      .nullish(),
    packDiscountPercentage: z
      .number({ invalid_type_error: "El descuento tiene que ser un número" })
      .int("El descuento tiene que ser un número entero")
      .min(0, "El descuento no puede ser negativo")
      .max(100, "El descuento no puede superar el 100%")
      .nullish(),
    packRoundingBase: z
      .number({ invalid_type_error: "El redondeo tiene que ser un número" })
      .int("El redondeo tiene que ser un número entero")
      .positive("El redondeo tiene que ser mayor que cero")
      .nullish(),
    servicesTogether: z.boolean().nullish(),
    // Sin `min(1)`: un pack que repite un combo NO lleva renglones propios. El
    // mínimo se pide más abajo, según el tipo.
    lines: z.array(lineSchema),
  })
  .superRefine((v, ctx) => {
    // ── Combo o pack ───────────────────────────────────────────────────────
    if (v.kind === "combo") {
      if (v.lines.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lines"],
          message: "El combo tiene que incluir al menos un servicio",
        });
      }
      if (v.packOfComboId != null || v.packSessions != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["kind"],
          message: "Un combo no lleva repeticiones: si querés repetirlo, armá un pack",
        });
      }
    } else {
      if (v.packSessions == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["packSessions"],
          message: "El pack tiene que decir cuántas veces se repite",
        });
      }
      if (v.servicesTogether === true) {
        // Un pack repite, no combina: si repite un combo el dato sale de ahí, y
        // si repite un servicio suelto no hay nada que juntar.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["servicesTogether"],
          message: "Un pack no define si los servicios se hacen juntos: eso lo dice el combo",
        });
      }
    }

    // Los dos campos del descuento propio van de a dos o ninguno, igual que en
    // `depilation_combo`: con uno solo no hay precio que calcular.
    if ((v.packDiscountPercentage == null) !== (v.packRoundingBase == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["packDiscountPercentage"],
        message: "El descuento propio necesita el porcentaje Y el redondeo, o ninguno de los dos",
      });
    }

    // "Se hacen juntos" con un solo servicio no significa nada.
    if (v.servicesTogether === true && v.lines.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["servicesTogether"],
        message: "\"Se hacen juntos\" necesita al menos dos servicios",
      });
    }

    if (v.priceType === "fixed" && v.fixedPrice == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixedPrice"],
        message: "Elegiste precio fijo: falta cargar el precio del combo",
      });
    }
    if (v.priceType === "percentage" && v.discountPercentage == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discountPercentage"],
        message: "Elegiste descuento por porcentaje: falta cargar el porcentaje",
      });
    }
    // La base tiene UNIQUE (combo_id, service_id); si no se chequea acá, el
    // error llega como un 500 de Postgres en vez de un mensaje entendible.
    const vistos = new Set<string>();
    for (const l of v.lines) {
      if (vistos.has(l.serviceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lines"],
          message: "Hay un servicio repetido: si necesitás más sesiones, subí la cantidad",
        });
        return;
      }
      vistos.add(l.serviceId);
    }
  });

// ── Pública (la consume piubella_web) ───────────────────────────────────────
combosRouter.get("/", async (c) => {
  const db = createDb(c.env);
  return c.json(await listPublicCombos(db));
});

// ── Admin (Administración → Combos) ─────────────────────────────────────────
combosRouter.get(
  "/admin",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator(
    "query",
    z.object({
      includeInactive: z.string().optional(),
      /** Cada solapa de área pasa la suya. Sin esto, todas. */
      areaCategoryId: z.string().uuid().optional(),
      /** `'combo'` para la solapa Combos, `'pack'` para la de Packs. */
      kind: z.enum(["combo", "pack"]).optional(),
    }),
  ),
  async (c) => {
    const db = createDb(c.env);
    const q = c.req.valid("query");
    return c.json(
      await listCombos(db, {
        includeInactive: q.includeInactive === "true",
        areaCategoryId: q.areaCategoryId,
        kind: q.kind,
      }),
    );
  },
);

/**
 * Qué ya existe igual a lo que se está por guardar.
 *
 * Endpoint aparte y no un chequeo dentro del alta porque el aviso tiene que
 * llegar ANTES de guardar: Pia pidió *"que el sistema le avise para que no se
 * dupliquen"*, y avisar después de crear el duplicado no evita nada.
 *
 * Nunca bloquea: devuelve la lista y quien está cargando decide.
 */
combosRouter.post(
  "/admin/duplicados",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", comboBody),
  async (c) => {
    const db = createDb(c.env);
    const { lines, ...header } = c.req.valid("json");
    return c.json({ duplicados: await duplicadosDe(db, header, lines) });
  },
);

// ⚠️ EL ORDEN IMPORTA. Todo lo que sea `/admin/<algo-fijo>` va ANTES de
// `/admin/:id`: Hono resuelve por orden de registro, así que registrado al
// revés `GET /admin/tarifarios` entraría por `/admin/:id` con
// id="tarifarios" y devolvería un 404 de combo inexistente. Mismo caso que
// `/credits/expired` en las rutas de saldos.

// ── El tarifario de packs por área (1.50.0) ─────────────────────────────────

/**
 * Cuánto descuento lleva un pack por defecto en cada área.
 *
 * Es la política: un pack que se salga de ella carga su propio descuento.
 * Cambiarla **no toca los packs ya guardados con descuento propio** ni los
 * precios ya vendidos, que `customer_purchase` congela al comprar.
 */
combosRouter.get(
  "/admin/tarifarios",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await listarTarifarios(db));
  },
);

const tarifarioBody = z.object({
  packSessions: z
    .number({ invalid_type_error: "Las sesiones tienen que ser un número" })
    .int("Las sesiones tienen que ser un número entero")
    .min(2, "Un pack repite al menos 2 veces")
    .max(MAX_PACK_SESSIONS, `Las sesiones no pueden superar ${MAX_PACK_SESSIONS}`),
  packDiscountPercentage: z
    .number({ invalid_type_error: "El descuento tiene que ser un número" })
    .int("El descuento tiene que ser un número entero")
    .min(0, "El descuento no puede ser negativo")
    .max(100, "El descuento no puede superar el 100%"),
  packRoundingBase: z
    .number({ invalid_type_error: "El redondeo tiene que ser un número" })
    .int("El redondeo tiene que ser un número entero")
    .positive("El redondeo tiene que ser mayor que cero"),
});

export { tarifarioBody };

combosRouter.put(
  "/admin/tarifarios/:areaCategoryId",
  auth,
  requireAuth,
  requirePermission("catalogo", "manage"),
  zValidator("json", tarifarioBody),
  async (c) => {
    const db = createDb(c.env);
    const guardado = await guardarTarifario(db, c.req.param("areaCategoryId"), c.req.valid("json"));
    if (!guardado) throw notFound("Tarifario");
    return c.json(guardado);
  },
);

combosRouter.get(
  "/admin/:id",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  async (c) => {
    const db = createDb(c.env);
    const combo = await getComboById(db, c.req.param("id"));
    if (!combo) throw notFound("Combo");
    return c.json(combo);
  },
);

combosRouter.post(
  "/admin",
  auth,
  requireAuth,
  requirePermission("catalogo", "manage"),
  zValidator("json", comboBody),
  async (c) => {
    const db = createDb(c.env);
    const { lines, ...header } = c.req.valid("json");

    // Las dos reglas del pack que un CHECK no puede pedir porque necesitan
    // mirar otra fila.
    const malDelPack = await validarPack(db, header, lines);
    if (malDelPack) return c.json({ error: malDelPack }, 400);

    // El aviso viaja con la respuesta además de estar en su propio endpoint:
    // así, si alguien crea sin pasar por la pantalla, el duplicado igual queda
    // registrado en la respuesta en vez de pasar en silencio.
    const duplicados = await duplicadosDe(db, header, lines);
    const created = await createCombo(db, header, lines);
    return c.json({ ...created!, duplicados }, 201);
  },
);

/**
 * Edita precio y presentación. **La composición y el área no se tocan** (spec
 * §4.2): cambiar qué servicios forman un combo lo convierte en otro producto y
 * deja a las compras viejas apuntando a algo que ya no es lo que se vendió.
 *
 * `lines`, `areaCategoryId`, `kind` y `packOfComboId` se aceptan en el cuerpo
 * —el formulario manda el objeto entero— pero se IGNORAN. Si el combo se cargó
 * mal, se borra (mientras no tenga compras) y se rehace.
 */
combosRouter.patch(
  "/admin/:id",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", comboBody),
  async (c) => {
    const db = createDb(c.env);
    const { lines: _lines, areaCategoryId: _area, kind: _kind, packOfComboId: _pack, packSessions: _n, ...header } =
      c.req.valid("json");
    const updated = await updateCombo(db, c.req.param("id"), header);
    if (!updated) throw notFound("Combo");
    return c.json(updated);
  },
);

combosRouter.delete(
  "/admin/:id",
  auth,
  requireAuth,
  requirePermission("catalogo", "manage"),
  async (c) => {
    const db = createDb(c.env);
    const archived = await setComboStatus(db, c.req.param("id"), false);
    if (!archived) throw notFound("Combo");
    return c.json(archived);
  },
);

combosRouter.post(
  "/admin/:id/restore",
  auth,
  requireAuth,
  requirePermission("catalogo", "manage"),
  async (c) => {
    const db = createDb(c.env);
    const restored = await setComboStatus(db, c.req.param("id"), true);
    if (!restored) throw notFound("Combo");
    return c.json(restored);
  },
);

// Impacto de un borrado real: si está bloqueado (compras o packs que lo
// repiten) y qué se desvincula — incluidas las promos que lo tienen en oferta.
// Sin esto el cartel prometía que no había nada colgando mientras la promo
// perdía su destino en silencio.
combosRouter.get(
  "/admin/:id/delete-impact",
  auth,
  requireAuth,
  requirePermission("catalogo", "manage"),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const combo = await getComboById(db, id);
    if (!combo) throw notFound("Combo");
    return c.json(await getComboDeleteImpact(db, id));
  },
);

combosRouter.delete(
  "/admin/:id/delete",
  auth,
  requireAuth,
  requirePermission("catalogo", "manage"),
  async (c) => {
    const db = createDb(c.env);
    const motivo = await deleteComboPermanently(db, c.req.param("id"));
    if (motivo === "El combo no existe") throw notFound("Combo");
    // 409 y no 400: no es un cuerpo mal armado, es que el estado actual no
    // permite el borrado. El texto va tal cual a la pantalla.
    if (motivo) return c.json({ error: motivo }, 409);
    return c.json({ ok: true });
  },
);

export { combosRouter };
