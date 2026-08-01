import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import {
  appointments,
  contacts,
  customers,
  invoices,
  lineItems,
  payments,
  products,
  service,
  serviceProviders,
} from "../db/schema";

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
      customerId: sql<string | null>`coalesce(${payments.customerId}, ${invoices.customerId})`,
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
    // El cobro no declarado de una cobranza mixta no tiene factura: su cliente
    // sale de payments.customer_id. Los pagos previos a 1.16.0 caen a la factura.
    .leftJoin(
      customers,
      eq(customers.id, sql`coalesce(${payments.customerId}, ${invoices.customerId})`),
    )
    .leftJoin(contacts, eq(contacts.id, customers.contactId))
    .leftJoin(serviceProviders, eq(serviceProviders.id, payments.receivedByProviderId))
    .leftJoin(appointments, eq(appointments.id, payments.appointmentId))
    .leftJoin(appointmentProvider, eq(appointmentProvider.id, appointments.serviceProviderId))
    .where(and(...conditions))
    .orderBy(asc(payments.paymentDate));
}

/**
 * Qué se cobró en cada pago, para nombrarlo en la rendición de caja.
 * Se busca por `payment_id` (línea propia del cobro) y, para los pagos previos
 * a 1.16.0 que no lo tienen, por la factura asociada.
 */
export async function listItemsForPayments(
  db: Db,
  paymentIds: string[],
  invoiceIds: string[],
) {
  if (paymentIds.length === 0 && invoiceIds.length === 0) return [];
  const byPayment = paymentIds.length ? inArray(lineItems.paymentId, paymentIds) : undefined;
  const byInvoice = invoiceIds.length
    ? and(isNull(lineItems.paymentId), inArray(lineItems.invoiceId, invoiceIds))
    : undefined;
  const where = byPayment && byInvoice ? or(byPayment, byInvoice) : (byPayment ?? byInvoice);

  return db
    .select({
      paymentId: lineItems.paymentId,
      invoiceId: lineItems.invoiceId,
      description: lineItems.description,
      quantity: lineItems.quantity,
      serviceName: service.name,
      productName: products.name,
    })
    .from(lineItems)
    .leftJoin(service, eq(service.id, lineItems.serviceId))
    .leftJoin(products, eq(products.id, lineItems.productId))
    .where(where);
}

/** Total pagado (confirmado) por turno — incluye señas y cobros parciales. */
export async function sumPaymentsByAppointmentIds(db: Db, appointmentIds: string[]) {
  if (appointmentIds.length === 0) return [];
  return db
    .select({
      appointmentId: payments.appointmentId,
      total: sql<string>`coalesce(sum(${payments.amount}), 0)`,
    })
    .from(payments)
    .where(
      and(
        inArray(payments.appointmentId, appointmentIds),
        eq(payments.status, "confirmed"),
      ),
    )
    .groupBy(payments.appointmentId);
}

/**
 * Total cobrado DIRECTO por cada proveedora en el rango (pagos que el cliente
 * le transfirió a ella y nunca entraron a PiuBella). Para la rendición: ese
 * dinero se descuenta de lo que PiuBella le debe por comisiones.
 */
export async function sumPaymentsReceivedByProvider(
  db: Db,
  range: { start: Date; end: Date },
) {
  return db
    .select({
      providerId: payments.receivedByProviderId,
      providerName: serviceProviders.fullName,
      total: sql<string>`coalesce(sum(${payments.amount}), 0)`,
    })
    .from(payments)
    .leftJoin(serviceProviders, eq(serviceProviders.id, payments.receivedByProviderId))
    .where(
      and(
        isNotNull(payments.receivedByProviderId),
        gte(payments.paymentDate, range.start),
        lt(payments.paymentDate, range.end),
      ),
    )
    .groupBy(payments.receivedByProviderId, serviceProviders.fullName);
}
