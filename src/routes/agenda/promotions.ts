import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { auth, requireAuth, requirePermission } from "../../middleware/auth";
import {
  createPromotion,
  listActivePromotions,
  listPromotions,
  setPromotionStatus,
  updatePromotion,
  updatePromotionFeatured,
} from "../../repositories/promotions.repo";
import type { AppBindings, Variables } from "../../env";

const promotionsRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// ── Público (booking + Destacados web) — NO cambiar shape ────────────────────
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

// ── Admin (Administración → Promos): CRUD con líneas + snapshot ──────────────
const n = (v: unknown) => (v == null ? null : Number(v));
function serialize(p: Record<string, unknown>) {
  const lines = Array.isArray(p.lines) ? (p.lines as Record<string, unknown>[]) : [];
  return {
    ...p,
    discountPercentage: n(p.discountPercentage),
    discountAmount: n(p.discountAmount),
    servicesSubtotal: n(p.servicesSubtotal),
    finalAmount: n(p.finalAmount),
    lines: lines.map((l) => ({
      ...l,
      servicePrice: n(l.servicePrice),
      providerPayment: n(l.providerPayment),
    })),
  };
}

const lineSchema = z.object({
  serviceId: z.string().uuid(),
  serviceProviderId: z.string().uuid().nullish(),
  providerPayment: z.number().nonnegative().nullish(),
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
  usageLimit: z.number().int().nonnegative().nullish(),
  notes: z.string().max(2000).nullish(),
});
const promoBody = headerSchema.extend({ lines: z.array(lineSchema).default([]) });

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
  const { lines, ...header } = c.req.valid("json");
  const created = await createPromotion(db, header, lines);
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
    const { lines, ...header } = c.req.valid("json");
    const updated = await updatePromotion(db, c.req.param("id"), header, lines);
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

export { promotionsRouter };
