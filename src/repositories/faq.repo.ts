import { asc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { faq } from "../db/schema";

const faqFields = {
  id: faq.id,
  question: faq.question,
  answer: faq.answer,
  category: faq.category,
  isActive: faq.isActive,
  displayOrder: faq.displayOrder,
  keywords: faq.keywords,
  createdAt: faq.createdAt,
  updatedAt: faq.updatedAt,
};

/** Lista las FAQ. Sin `includeInactive`, oculta las archivadas (is_active=false). */
export async function listFaqs(db: Db, includeInactive = false) {
  const base = db.select(faqFields).from(faq);
  const ordered = includeInactive ? base : base.where(ne(faq.isActive, false));
  return ordered.orderBy(asc(faq.displayOrder), asc(faq.question));
}

type FaqWritable = {
  question?: string | null;
  answer?: string | null;
  category?: string | null;
  displayOrder?: number | null;
  keywords?: string[] | null;
  isActive?: boolean | null;
};

export async function createFaq(db: Db, data: FaqWritable & { createdByUserId?: string | null }) {
  const [row] = await db
    .insert(faq)
    .values({ isActive: true, ...data })
    .returning(faqFields);
  return row;
}

export async function updateFaq(db: Db, id: string, patch: FaqWritable) {
  const rows = await db.update(faq).set(patch).where(eq(faq.id, id)).returning(faqFields);
  return rows[0] ?? null;
}

export async function setFaqActive(db: Db, id: string, isActive: boolean) {
  const rows = await db.update(faq).set({ isActive }).where(eq(faq.id, id)).returning(faqFields);
  return rows[0] ?? null;
}
