import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts, customers } from "../db/schema";

const customerSummary = {
  id: customers.id,
  contactId: customers.contactId,
  dni: customers.dni,
  cuit: customers.cuit,
  creditBalance: customers.creditBalance,
  name: contacts.name,
  phone: contacts.phone,
  email: contacts.email,
};

export async function searchCustomers(db: Db, q: string, limit = 20) {
  const pattern = `%${q}%`;
  return db
    .select(customerSummary)
    .from(customers)
    .innerJoin(contacts, eq(contacts.id, customers.contactId))
    .where(
      or(
        ilike(contacts.name, pattern),
        ilike(customers.dni, pattern),
        ilike(contacts.phone, pattern),
      ),
    )
    .limit(limit);
}

export async function getCustomerById(db: Pick<Db, "select">, id: string) {
  const rows = await db
    .select(customerSummary)
    .from(customers)
    .innerJoin(contacts, eq(contacts.id, customers.contactId))
    .where(eq(customers.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Igual que `getCustomerById` pero busca por CONTACT id en vez de CUSTOMER id —
 *  usar cuando lo único disponible es el `contactId` (ej: `deals.contactId`),
 *  que es una FK a `contacts`, no a `customers`. */
export async function getCustomerByContactId(db: Pick<Db, "select">, contactId: string) {
  const rows = await db
    .select(customerSummary)
    .from(customers)
    .innerJoin(contacts, eq(contacts.id, customers.contactId))
    .where(eq(customers.contactId, contactId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findCustomerByDni(db: Db, dni: string) {
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.dni, dni)))
    .limit(1);
  return rows[0] ?? null;
}

/** Alta rápida: crea CONTACT (status customer) + CUSTOMER en una transacción. */
export async function createQuickCustomer(
  db: Db,
  data: { name: string; dni: string; phone?: string; email?: string },
) {
  return db.transaction(async (tx) => {
    const [contact] = await tx
      .insert(contacts)
      .values({
        name: data.name,
        phone: data.phone ?? null,
        email: data.email ?? null,
        status: "customer",
        country: "AR",
        firstContactDate: new Date(),
        isArchived: false,
      })
      .returning({ id: contacts.id });

    const [customer] = await tx
      .insert(customers)
      .values({
        contactId: contact!.id,
        dni: data.dni,
        firstPurchaseDate: new Date(),
      })
      .returning({ id: customers.id });

    return { customerId: customer!.id, contactId: contact!.id };
  });
}

export async function listRecentCustomers(db: Db, limit = 20) {
  return db
    .select(customerSummary)
    .from(customers)
    .innerJoin(contacts, eq(contacts.id, customers.contactId))
    .orderBy(desc(customers.createdAt))
    .limit(limit);
}

/** Acredita `amount` al saldo a favor del cliente. Se llama dentro de la misma
 *  transacción que cancela el deal (ver appointments.service.ts). `sql` suma
 *  sobre el valor actual en la propia query — no hay condición de carrera entre
 *  leer y escribir el balance. */
export async function creditCustomer(
  tx: Pick<Db, "update">,
  customerId: string,
  amount: number,
) {
  await tx
    .update(customers)
    .set({ creditBalance: sql`${customers.creditBalance} + ${amount}` })
    .where(eq(customers.id, customerId));
}
