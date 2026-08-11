import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  analyticsEvents,
  callLogs,
  contacts,
  conversations,
  customers,
  deals,
  messages,
} from "../db/schema";

export type ContactSort = "recent" | "nameAsc" | "nameDesc";

// `lower(...)` porque sin eso "ana" cae después de "Zulema" en las collations que
// ordenan por byte. NULLS LAST en los dos sentidos: un contacto sin nombre es
// basura al final de la lista, nunca lo primero que ve la dueña al invertir el orden.
// El desempate por `id` es obligatorio con paginación: dos "María González" sin
// desempate pueden aparecer dos veces o ninguna al pasar de página.
const ORDER_BY: Record<ContactSort, ReturnType<typeof sql>> = {
  recent: sql`${contacts.createdAt} DESC, ${contacts.id}`,
  nameAsc: sql`lower(${contacts.name}) ASC NULLS LAST, ${contacts.id}`,
  nameDesc: sql`lower(${contacts.name}) DESC NULLS LAST, ${contacts.id}`,
};

export async function listContacts(
  db: Db,
  filters: {
    q?: string;
    limit: number;
    offset: number;
    includeArchived?: boolean;
    sort?: ContactSort;
  },
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
      .orderBy(ORDER_BY[filters.sort ?? "recent"])
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

/** Borra el cliente y sus rastros de CRM en una transacción.
 *
 *  El caller (la ruta) DEBE haber verificado que `getClientDeleteImpact` no
 *  esté `blocked`. Acá no aparecen invoices, payments, line_items, arca_logs,
 *  payment_logs ni cash_register a propósito: si el cliente tiene alguna de
 *  esas filas no llega a esta función.
 *
 *  Por el mismo motivo no hay que romper el ciclo de FK entre appointments y
 *  deals (appointments.deal_id ↔ deals.appointment_id): un cliente sin turnos
 *  no tiene appointments del otro lado del ciclo.
 *
 *  Orden hijos → padre. `contact_notes` y `message_queue` caen solos por
 *  ON DELETE CASCADE; `delivery_logs.contact_id` queda en NULL. */
export async function hardDeleteClient(db: Db, contactId: string): Promise<boolean> {
  const deleted = await db.transaction(async (tx) => {
    const conv = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.contactId, contactId));

    if (conv.length > 0) {
      const ids = conv.map((r) => r.id);
      await tx.delete(messages).where(inArray(messages.conversationId, ids));
      await tx.delete(conversations).where(eq(conversations.contactId, contactId));
    }

    await tx.delete(deals).where(eq(deals.contactId, contactId));
    await tx.delete(callLogs).where(eq(callLogs.contactId, contactId));
    await tx.delete(analyticsEvents).where(eq(analyticsEvents.contactId, contactId));
    await tx.delete(customers).where(eq(customers.contactId, contactId));

    return tx.delete(contacts).where(eq(contacts.id, contactId)).returning({ id: contacts.id });
  });
  return deleted.length > 0;
}
