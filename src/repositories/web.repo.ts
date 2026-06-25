import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { webGallery, webTestimonials } from "../db/schema";

// ── Galería ──────────────────────────────────────────────────────────────────

const galleryFields = {
  id: webGallery.id,
  r2Path: webGallery.r2Path,
  publicUrl: webGallery.publicUrl,
  alt: webGallery.alt,
  caption: webGallery.caption,
  sortOrder: webGallery.sortOrder,
  isVisible: webGallery.isVisible,
  createdAt: webGallery.createdAt,
};

export async function listGallery(db: Db) {
  return db
    .select(galleryFields)
    .from(webGallery)
    .orderBy(asc(webGallery.sortOrder), desc(webGallery.createdAt));
}

type GalleryWritable = {
  publicUrl?: string | null;
  r2Path?: string | null;
  alt?: string | null;
  caption?: string | null;
  sortOrder?: number | null;
  isVisible?: boolean | null;
};

export async function createGalleryItem(db: Db, data: GalleryWritable) {
  const [row] = await db.insert(webGallery).values(data).returning(galleryFields);
  return row;
}

export async function updateGalleryItem(db: Db, id: string, patch: GalleryWritable) {
  const rows = await db
    .update(webGallery)
    .set(patch)
    .where(eq(webGallery.id, id))
    .returning(galleryFields);
  return rows[0] ?? null;
}

export async function deleteGalleryItem(db: Db, id: string) {
  const rows = await db.delete(webGallery).where(eq(webGallery.id, id)).returning({ id: webGallery.id });
  return rows[0] ?? null;
}

// ── Testimonios ──────────────────────────────────────────────────────────────

const testimonialFields = {
  id: webTestimonials.id,
  authorName: webTestimonials.authorName,
  body: webTestimonials.body,
  rating: webTestimonials.rating,
  isVisible: webTestimonials.isVisible,
  createdAt: webTestimonials.createdAt,
};

export async function listTestimonials(db: Db) {
  return db.select(testimonialFields).from(webTestimonials).orderBy(desc(webTestimonials.createdAt));
}

type TestimonialWritable = {
  authorName?: string | null;
  body?: string | null;
  rating?: number | null;
  isVisible?: boolean | null;
};

export async function createTestimonial(db: Db, data: TestimonialWritable) {
  const [row] = await db.insert(webTestimonials).values(data).returning(testimonialFields);
  return row;
}

export async function updateTestimonial(db: Db, id: string, patch: TestimonialWritable) {
  const rows = await db
    .update(webTestimonials)
    .set(patch)
    .where(eq(webTestimonials.id, id))
    .returning(testimonialFields);
  return rows[0] ?? null;
}

export async function deleteTestimonial(db: Db, id: string) {
  const rows = await db
    .delete(webTestimonials)
    .where(eq(webTestimonials.id, id))
    .returning({ id: webTestimonials.id });
  return rows[0] ?? null;
}
