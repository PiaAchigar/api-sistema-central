import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { auth, requireAuth, requirePermission } from "../../middleware/auth";
import {
  createCombo,
  deleteComboPermanently,
  getComboById,
  listCombos,
  listPublicCombos,
  setComboStatus,
  updateCombo,
} from "../../repositories/combos.repo";
import type { AppBindings, Variables } from "../../env";

const combosRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

const lineSchema = z.object({
  serviceId: z.string().uuid(),
  sessionsIncluded: z.number().int().min(1, "Cada servicio tiene que llevar al menos 1 sesión"),
});

/**
 * Validación del cuerpo. Los mensajes van en castellano porque llegan tal cual
 * a la pantalla: `textoDeError()` en el front desarma el ZodError y muestra
 * "campo: mensaje".
 */
export const comboBody = z
  .object({
    name: z.string().min(1, "El nombre es obligatorio").max(200),
    description: z.string().max(2000).nullish(),
    priceType: z.enum(["fixed", "percentage"]),
    fixedPrice: z.number().nonnegative().nullish(),
    discountPercentage: z.number().min(0).max(100).nullish(),
    validityMonths: z
      .number()
      .int()
      .min(1, "La vigencia tiene que ser de al menos 1 mes"),
    isVisibleWeb: z.boolean().nullish(),
    displayOrder: z.number().int().nonnegative().nullish(),
    lines: z.array(lineSchema).min(1, "El combo tiene que incluir al menos un servicio"),
  })
  .superRefine((v, ctx) => {
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
  zValidator("query", z.object({ includeInactive: z.string().optional() })),
  async (c) => {
    const db = createDb(c.env);
    const includeInactive = c.req.valid("query").includeInactive === "true";
    return c.json(await listCombos(db, includeInactive));
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
    const created = await createCombo(db, header, lines);
    return c.json(created!, 201);
  },
);

combosRouter.patch(
  "/admin/:id",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", comboBody),
  async (c) => {
    const db = createDb(c.env);
    const { lines, ...header } = c.req.valid("json");
    const updated = await updateCombo(db, c.req.param("id"), header, lines);
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

combosRouter.delete(
  "/admin/:id/delete",
  auth,
  requireAuth,
  requirePermission("catalogo", "manage"),
  async (c) => {
    const db = createDb(c.env);
    const deleted = await deleteComboPermanently(db, c.req.param("id"));
    if (!deleted) throw notFound("Combo");
    return c.json({ ok: true });
  },
);

export { combosRouter };
