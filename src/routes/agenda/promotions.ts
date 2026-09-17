import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { auth, requireAuth, requirePermission } from "../../middleware/auth";
import {
  createPromotion,
  deletePromotionPermanently,
  getPromotionById,
  getPromotionDeleteImpact,
  listActivePromotions,
  listPromotions,
  setPromotionStatus,
  updatePromotion,
  updatePromotionFeatured,
} from "../../repositories/promotions.repo";
import type { AppBindings, Variables } from "../../env";

const promotionsRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// ── Público — el único consumidor es la web (piubella_web) ──────────────────
// Devuelve `targets` (qué está en oferta), no `services`: el shape cambió en
// la 1.53.0 y la web se adaptó en la misma tanda. Destacados del dashboard ya
// no pasa por acá —necesita ver también las promos sin publicar, así que usa
// `/admin`— y front-agenda no lo consume. Si mañana cambia el shape otra vez,
// lo que hay que mirar es `piubella_web`.
const listQuery = z.object({
  featured: z.string().optional().transform((v) => v === "true"),
});

promotionsRouter.get("/", zValidator("query", listQuery), async (c) => {
  const db = createDb(c.env);
  const { featured } = c.req.valid("query");
  const promos = await listActivePromotions(db, { featured });
  return c.json(promos);
});

// Toggle "destacada" (usado por la web / Sitio Web → Destacados).
const patchPromoBody = z.object({ isFeatured: z.boolean() });
promotionsRouter.patch("/:id", auth, requireAuth, zValidator("json", patchPromoBody), async (c) => {
  const db = createDb(c.env);
  const updated = await updatePromotionFeatured(db, c.req.param("id"), c.req.valid("json").isFeatured);
  if (!updated) return c.json({ error: "Promotion not found" }, 404);
  return c.json(updated);
});

// ── Admin (Administración → Promos): CRUD con destinos + pagos acordados ─────
const n = (v: unknown) => (v == null ? null : Number(v));
function serialize(p: Record<string, unknown>) {
  const pagos = Array.isArray(p.pagos) ? (p.pagos as Record<string, unknown>[]) : [];
  const destinos = Array.isArray(p.destinos) ? (p.destinos as Record<string, unknown>[]) : [];
  return {
    ...p,
    discountPercentage: n(p.discountPercentage),
    discountAmount: n(p.discountAmount),
    pagos: pagos.map((pago) => ({
      ...pago,
      providerPayment: n(pago.providerPayment),
    })),
    destinos,
  };
}

const destinoSchema = z.object({
  tipo: z.enum(["servicio", "combo", "depilacion"]),
  id: z.string().uuid(),
});
const pagoSchema = z.object({
  serviceId: z.string().uuid(),
  serviceProviderId: z.string().uuid(),
  providerPayment: z.number().nonnegative(),
});
const headerSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullish(),
  promotionType: z.enum(["percentage", "fixed_amount"]).nullish(),
  discountPercentage: z.number().min(0).max(100).nullish(),
  discountAmount: z.number().nonnegative().nullish(),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  isFeatured: z.boolean().nullish(),
  isVisibleWeb: z.boolean().nullish(),
  usageLimit: z.number().int().nonnegative().nullish(),
  notes: z.string().max(2000).nullish(),
});
const promoBody = headerSchema.extend({
  // Una promo sin destinos no significa "aplica a todo": significa que Laura
  // se olvidó de marcar algo. Se rechaza acá y no en la pantalla, porque la
  // pantalla se puede saltear.
  destinos: z.array(destinoSchema).min(1),
  pagos: z.array(pagoSchema).default([]),
});

promotionsRouter.get(
  "/admin",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("query", z.object({ includeInactive: z.string().optional() })),
  async (c) => {
    const db = createDb(c.env);
    const includeInactive = c.req.valid("query").includeInactive === "true";
    const rows = await listPromotions(db, includeInactive);
    return c.json(rows.map(serialize));
  },
);

promotionsRouter.post("/admin", auth, requireAuth, requirePermission("catalogo", "manage"), zValidator("json", promoBody), async (c) => {
  const db = createDb(c.env);
  const { destinos, pagos, ...header } = c.req.valid("json");
  const created = await createPromotion(db, header, destinos, pagos);
  return c.json(serialize(created!), 201);
});

promotionsRouter.patch(
  "/admin/:id",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", promoBody),
  async (c) => {
    const db = createDb(c.env);
    const { destinos, pagos, ...header } = c.req.valid("json");
    const updated = await updatePromotion(db, c.req.param("id"), header, destinos, pagos);
    if (!updated) throw notFound("Promotion");
    return c.json(serialize(updated));
  },
);

promotionsRouter.delete("/admin/:id", auth, requireAuth, requirePermission("catalogo", "manage"), async (c) => {
  const db = createDb(c.env);
  const archived = await setPromotionStatus(db, c.req.param("id"), "inactive");
  if (!archived) throw notFound("Promotion");
  return c.json(serialize(archived));
});

promotionsRouter.post("/admin/:id/restore", auth, requireAuth, requirePermission("catalogo", "manage"), async (c) => {
  const db = createDb(c.env);
  const restored = await setPromotionStatus(db, c.req.param("id"), "active");
  if (!restored) throw notFound("Promotion");
  return c.json(serialize(restored));
});

// Qué se lleva puesto el borrado definitivo. Nunca bloquea (las ventas
// conservan su `promotion_name`), pero tiene que decir lo que cambia en
// silencio: las ventas que quedan sin promo y los pagos acordados que se
// borran — con esos pagos se va el monto negociado de todo turno de esas
// ventas que todavía no se completó.
promotionsRouter.get(
  "/admin/:id/delete-impact",
  auth,
  requireAuth,
  requirePermission("catalogo", "manage"),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const promo = await getPromotionById(db, id);
    if (!promo) throw notFound("Promotion");
    return c.json(await getPromotionDeleteImpact(db, id));
  },
);

promotionsRouter.delete("/admin/:id/delete", auth, requireAuth, requirePermission("catalogo", "manage"), async (c) => {
  const db = createDb(c.env);
  const deleted = await deletePromotionPermanently(db, c.req.param("id"));
  if (!deleted) throw notFound("Promotion");
  return c.json({ ok: true });
});

export { promotionsRouter };
