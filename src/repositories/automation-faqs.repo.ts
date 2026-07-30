import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { automationFaqs } from "../db/schema";

export async function listFaqs(db: Db) {
  return db.select().from(automationFaqs).orderBy(asc(automationFaqs.createdAt));
}

/** Solo las activas, con las columnas que necesita el motor para matchear. */
export async function listActiveFaqs(db: Db) {
  return db
    .select({
      id: automationFaqs.id,
      answer: automationFaqs.answer,
      keywords: automationFaqs.keywords,
    })
    .from(automationFaqs)
    .where(eq(automationFaqs.isActive, true))
    .orderBy(asc(automationFaqs.createdAt));
}

export async function getFaqById(db: Db, id: string) {
  const rows = await db.select().from(automationFaqs).where(eq(automationFaqs.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function createFaq(db: Db, data: typeof automationFaqs.$inferInsert) {
  const rows = await db.insert(automationFaqs).values(data).returning();
  return rows[0]!;
}

export async function updateFaq(
  db: Db,
  id: string,
  data: Partial<typeof automationFaqs.$inferInsert>,
) {
  const rows = await db
    .update(automationFaqs)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(automationFaqs.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteFaq(db: Db, id: string) {
  const rows = await db
    .delete(automationFaqs)
    .where(eq(automationFaqs.id, id))
    .returning({ id: automationFaqs.id });
  return rows[0] ?? null;
}
