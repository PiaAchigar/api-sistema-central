import { and, asc, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts, customers, invoices, payments, serviceProviders } from "../db/schema";

type Tx = Pick<Db, "select" | "insert" | "update">;

export async function insertPayment(tx: Tx, values: typeof payments.$inferInsert) {
  const rows = await tx.insert(payments).values(values).returning();
  return rows[0]!;
}

export async function listPaymentsByRange(
  db: Db,
  range: { start: Date; end: Date },
  filters: { method?: string } = {},
) {
  const conditions = [
    gte(payments.paymentDate, range.start),
    lt(payments.paymentDate, range.end),
  ];
  if (filters.method) conditions.push(eq(payments.paymentMethod, filters.method));

  return db
    .select({
      id: payments.id,
      amount: payments.amount,
      paymentMethod: payments.paymentMethod,
      status: payments.status,
      paymentDate: payments.paymentDate,
      isDeclared: payments.isDeclared,
      notes: payments.notes,
      invoiceId: payments.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      customerName: contacts.name,
      receivedByProviderId: payments.receivedByProviderId,
      receivedByProviderName: serviceProviders.fullName,
    })
    .from(payments)
    .leftJoin(invoices, eq(invoices.id, payments.invoiceId))
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(contacts, eq(contacts.id, customers.contactId))
    .leftJoin(serviceProviders, eq(serviceProviders.id, payments.receivedByProviderId))
    .where(and(...conditions))
    .orderBy(asc(payments.paymentDate));
}
