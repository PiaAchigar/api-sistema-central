import { and, asc, eq, gte, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import { appointments, contacts, customers, invoices, payments, serviceProviders } from "../db/schema";

type Tx = Pick<Db, "select" | "insert" | "update">;

const appointmentProvider = alias(serviceProviders, "appointment_provider");

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
      // Comisión de la proveedora en el turno que originó este pago (si vino de
      // un checkout con appointmentId) — para desglosarla en la rendición de caja.
      appointmentId: payments.appointmentId,
      appointmentProviderName: appointmentProvider.fullName,
      appointmentProviderEarning: appointments.providerEarning,
    })
    .from(payments)
    .leftJoin(invoices, eq(invoices.id, payments.invoiceId))
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(contacts, eq(contacts.id, customers.contactId))
    .leftJoin(serviceProviders, eq(serviceProviders.id, payments.receivedByProviderId))
    .leftJoin(appointments, eq(appointments.id, payments.appointmentId))
    .leftJoin(appointmentProvider, eq(appointmentProvider.id, appointments.serviceProviderId))
    .where(and(...conditions))
    .orderBy(asc(payments.paymentDate));
}
