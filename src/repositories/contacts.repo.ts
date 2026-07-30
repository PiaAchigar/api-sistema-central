import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts } from "../db/schema";

export async function listContacts(
  db: Db,
  filters: { status?: string; q?: string; limit: number; offset: number; includeArchived?: boolean },
) {
  const conditions = [];
  if (!filters.includeArchived) conditions.push(sql`${contacts.isArchived} IS NOT TRUE`);
  if (filters.status) conditions.push(eq(contacts.status, filters.status));
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    conditions.push(
      or(ilike(contacts.name, pattern), ilike(contacts.phone, pattern), ilike(contacts.email, pattern)),
    );
  }

  return db
    .select()
    .from(contacts)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(contacts.createdAt))
    .limit(filters.limit)
    .offset(filters.offset);
}

export async function getContactById(db: Db, id: string) {
  const rows = await db.select().from(contacts).where(eq(contacts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getContactByWhatsappId(db: Db, whatsappId: string) {
  const rows = await db.select().from(contacts).where(eq(contacts.whatsappId, whatsappId)).limit(1);
  return rows[0] ?? null;
}

export async function createContact(db: Db, data: typeof contacts.$inferInsert) {
  const rows = await db
    .insert(contacts)
    .values({ ...data, firstContactDate: new Date(), isArchived: false })
    .returning();
  return rows[0]!;
}

export async function updateContact(
  db: Db,
  id: string,
  data: Partial<typeof contacts.$inferInsert>,
) {
  const rows = await db.update(contacts).set(data).where(eq(contacts.id, id)).returning();
  return rows[0] ?? null;
}
