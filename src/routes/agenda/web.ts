import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { auth, requireAdmin, requireAuth, requireRole } from "../../middleware/auth";
import {
  createGalleryItem,
  createTestimonial,
  deleteGalleryItem,
  deleteTestimonial,
  listGallery,
  listTestimonials,
  updateGalleryItem,
  updateTestimonial,
} from "../../repositories/web.repo";
import type { AppBindings, Variables } from "../../env";

const STAFF = ["admin", "manager", "operator"] as const;

const webRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// ── Galería ──────────────────────────────────────────────────────────────────
webRouter.get("/gallery", auth, requireAuth, requireRole(...STAFF), async (c) => {
  const db = createDb(c.env);
  return c.json(await listGallery(db));
});

const galleryBody = z.object({
  publicUrl: z.string().max(500).nullish(),
  r2Path: z.string().max(500).nullish(),
  alt: z.string().max(255).nullish(),
  caption: z.string().max(500).nullish(),
  sortOrder: z.number().int().nullish(),
  isVisible: z.boolean().nullish(),
});

webRouter.post(
  "/gallery",
  auth,
  requireAuth,
  requireAdmin,
  zValidator("json", galleryBody),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await createGalleryItem(db, c.req.valid("json")), 201);
  },
);

webRouter.patch(
  "/gallery/:id",
  auth,
  requireAuth,
  requireRole(...STAFF),
  zValidator("json", galleryBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateGalleryItem(db, c.req.param("id"), c.req.valid("json"));
    if (!updated) throw notFound("GalleryItem");
    return c.json(updated);
  },
);

webRouter.delete("/gallery/:id", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const deleted = await deleteGalleryItem(db, c.req.param("id"));
  if (!deleted) throw notFound("GalleryItem");
  return c.json({ ok: true });
});

// ── Testimonios ──────────────────────────────────────────────────────────────
webRouter.get("/testimonials", auth, requireAuth, requireRole(...STAFF), async (c) => {
  const db = createDb(c.env);
  return c.json(await listTestimonials(db));
});

const testimonialBody = z.object({
  authorName: z.string().max(255).nullish(),
  body: z.string().max(5000).nullish(),
  rating: z.number().int().min(1).max(5).nullish(),
  isVisible: z.boolean().nullish(),
});

webRouter.post(
  "/testimonials",
  auth,
  requireAuth,
  requireAdmin,
  zValidator("json", testimonialBody),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await createTestimonial(db, c.req.valid("json")), 201);
  },
);

webRouter.patch(
  "/testimonials/:id",
  auth,
  requireAuth,
  requireRole(...STAFF),
  zValidator("json", testimonialBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateTestimonial(db, c.req.param("id"), c.req.valid("json"));
    if (!updated) throw notFound("Testimonial");
    return c.json(updated);
  },
);

webRouter.delete("/testimonials/:id", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const deleted = await deleteTestimonial(db, c.req.param("id"));
  if (!deleted) throw notFound("Testimonial");
  return c.json({ ok: true });
});

export { webRouter };
