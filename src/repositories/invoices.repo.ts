import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  arcaIssuers,
  arcaLogs,
  contacts,
  customers,
  invoices,
  lineItems,
  products,
  service,
} from "../db/schema";

type Tx = Pick<Db, "select" | "insert" | "update">;

const invoiceSummary = {
  id: invoices.id,
  invoiceNumber: invoices.invoiceNumber,
  invoiceType: invoices.invoiceType,
  subtotal: invoices.subtotal,
  taxAmount: invoices.taxAmount,
  adjustmentAmount: invoices.adjustmentAmount,
  totalAmount: invoices.totalAmount,
  status: invoices.status,
  invoiceDate: invoices.invoiceDate,
  emittedAt: invoices.emittedAt,
  customerId: invoices.customerId,
  customerName: contacts.name,
  customerDni: customers.dni,
  // Facturador con el que se emite (NULL en facturas previas al multi-facturador)
  issuerId: invoices.issuerId,
  issuerName: arcaIssuers.name,
  issuerCuit: arcaIssuers.cuit,
};

export async function listInvoices(
  db: Db,
  filters: { status?: string; customerId?: string; from?: Date; to?: Date },
) {
  const conditions = [];
  if (filters.status) conditions.push(eq(invoices.status, filters.status));
  if (filters.customerId) conditions.push(eq(invoices.customerId, filters.customerId));
  if (filters.from) conditions.push(gte(invoices.invoiceDate, filters.from));
  if (filters.to) conditions.push(lte(invoices.invoiceDate, filters.to));

  return db
    .select(invoiceSummary)
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(contacts, eq(contacts.id, customers.contactId))
    .leftJoin(arcaIssuers, eq(arcaIssuers.id, invoices.issuerId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(invoices.invoiceDate))
    .limit(200);
}

export async function getInvoiceById(db: Db, id: string) {
  const rows = await db
    .select(invoiceSummary)
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(contacts, eq(contacts.id, customers.contactId))
    .leftJoin(arcaIssuers, eq(arcaIssuers.id, invoices.issuerId))
    .where(eq(invoices.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getInvoiceLineItems(db: Db, invoiceId: string) {
  return db
    .select({
      id: lineItems.id,
      description: lineItems.description,
      serviceId: lineItems.serviceId,
      productId: lineItems.productId,
      quantity: lineItems.quantity,
      unitPrice: lineItems.unitPrice,
      taxAmount: lineItems.taxAmount,
      subtotal: lineItems.subtotal,
      totalAmount: lineItems.totalAmount,
      serviceName: service.name,
      productName: products.name,
    })
    .from(lineItems)
    .leftJoin(service, eq(service.id, lineItems.serviceId))
    .leftJoin(products, eq(products.id, lineItems.productId))
    .where(eq(lineItems.invoiceId, invoiceId));
}

export async function getArcaLogsForInvoice(db: Db, invoiceId: string) {
  return db
    .select()
    .from(arcaLogs)
    .where(eq(arcaLogs.invoiceId, invoiceId))
    .orderBy(asc(arcaLogs.createdAt));
}

export async function insertInvoice(tx: Tx, values: typeof invoices.$inferInsert) {
  const rows = await tx.insert(invoices).values(values).returning();
  return rows[0]!;
}

export async function insertLineItems(tx: Tx, values: (typeof lineItems.$inferInsert)[]) {
  if (values.length === 0) return [];
  return tx.insert(lineItems).values(values).returning();
}

export async function updateInvoice(
  tx: Tx,
  id: string,
  values: Partial<typeof invoices.$inferInsert>,
) {
  const rows = await tx.update(invoices).set(values).where(eq(invoices.id, id)).returning();
  return rows[0] ?? null;
}

export async function insertArcaLog(tx: Tx, values: typeof arcaLogs.$inferInsert) {
  const rows = await tx.insert(arcaLogs).values(values).returning();
  return rows[0]!;
}

/**
 * Próximo correlativo propuesto para un tipo de comprobante, POR FACTURADOR:
 * cada CUIT+punto de venta lleva su propia numeración ante ARCA, así que mezclar
 * facturadores daría números disparatados. Igual es solo una propuesta — ante
 * ARCA manda `FECompUltimoAutorizado` (ver afip-client.ts).
 */
export async function getNextInvoiceNumber(
  tx: Tx,
  invoiceType: string,
  issuerId: string | null,
): Promise<number> {
  const rows = await tx
    .select({ max: sql<number | null>`max(${invoices.invoiceNumber})` })
    .from(invoices)
    .where(
      and(
        eq(invoices.invoiceType, invoiceType),
        issuerId ? eq(invoices.issuerId, issuerId) : isNull(invoices.issuerId),
      ),
    );
  return (rows[0]?.max ?? 0) + 1;
}

export async function listDraftInvoiceIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.status, "draft"))
    .orderBy(asc(invoices.createdAt));
  return rows.map((r) => r.id);
}
