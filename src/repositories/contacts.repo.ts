import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts } from "../db/schema";

export async function listContacts(
  db: Db,
  filters: { q?: string; limit: number; offset: number; includeArchived?: boolean },
) {
  const conditions = [];
  if (!filters.includeArchived) conditions.push(sql`${contacts.isArchived} IS NOT TRUE`);
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    conditions.push(
      or(ilike(contacts.name, pattern), ilike(contacts.phone, pattern), ilike(contacts.email, pattern)),
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // El total se cuenta con el MISMO where que la página: si contara sin filtros,
  // el "Mostrando 1-50 de N" mentiría apenas la dueña escriba algo en el buscador.
  const [items, totalRows] = await Promise.all([
    db
      .select()
      .from(contacts)
      .where(where)
      .orderBy(desc(contacts.createdAt))
      .limit(filters.limit)
      .offset(filters.offset),
    db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(where),
  ]);

  return { items, total: totalRows[0]?.n ?? 0 };
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
