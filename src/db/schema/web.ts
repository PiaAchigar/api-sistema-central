import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at").$defaultFn(() => new Date());

export const webGallery = pgTable("web_gallery", {
  id: id(),
  r2Path: varchar("r2_path", { length: 500 }),
  publicUrl: varchar("public_url", { length: 500 }),
  alt: varchar("alt", { length: 255 }),
  caption: varchar("caption", { length: 500 }),
  sortOrder: integer("sort_order"),
  isVisible: boolean("is_visible"),
  createdAt: createdAt(),
});

export const webTestimonials = pgTable("web_testimonials", {
  id: id(),
  authorName: varchar("author_name", { length: 255 }),
  body: text("body"),
  rating: integer("rating"),
  isVisible: boolean("is_visible"),
  createdAt: createdAt(),
});

export const contactNotes = pgTable("contact_notes", {
  id: id(),
  contactId: uuid("contact_id"),
  body: text("body"),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
});
