import { resolveArcaConfig, type ArcaConfig } from "../arca/factory";
import type { AppBindings } from "../env";
import type { Db } from "../db/client";
import { badGateway, badRequest, conflict, notFound } from "../lib/errors";
import {
  getArcaLogsForInvoice,
  getInvoiceById,
  getInvoiceLineItems,
  getNextInvoiceNumber,
  insertArcaLog,
  insertInvoice,
  insertLineItems,
  listDraftInvoiceIds,
  listInvoices,
  updateInvoice,
} from "../repositories/invoices.repo";
import { getCustomerById } from "../repositories/customers.repo";
import { getServiceById } from "../repositories/services.repo";
import { eq } from "drizzle-orm";
import { products } from "../db/schema";

export type DraftItemInput = {
  serviceId?: string;
  productId?: string;
  quantity: number;
  /** Si no viene, se resuelve del catálogo. */
  unitPrice?: number;
  priceMode?: "list" | "cash";
  /** false ⇒ este ítem NO va a la factura ARCA (cobro en negro). Default true. */
  billable?: boolean;
};

type ResolvedItem = {
  serviceId: string | null;
  productId: string | null;
  quantity: number;
  unitPrice: number;
  billable: boolean;
};

export async function resolveItems(db: Db, items: DraftItemInput[]): Promise<ResolvedItem[]> {
  const resolved: ResolvedItem[] = [];
  for (const item of items) {
    if (!item.serviceId && !item.productId) {
      throw badRequest("Cada ítem necesita serviceId o productId");
    }
    if (item.serviceId && item.productId) {
      throw badRequest("Un ítem no puede ser servicio y producto a la vez");
    }
    let unitPrice = item.unitPrice;
    if (unitPrice == null) {
      if (item.serviceId) {
        const svc = await getServiceById(db, item.serviceId);
        if (!svc) throw notFound("Service");
        unitPrice = Number(
          (item.priceMode === "cash" ? svc.unitPriceCash : svc.unitPriceList) ?? 0,
        );
      } else {
        const rows = await db
          .select({ unitPrice: products.unitPrice })
          .from(products)
          .where(eq(products.id, item.productId!))
          .limit(1);
        if (!rows[0]) throw notFound("Product");
        unitPrice = Number(rows[0].unitPrice ?? 0);
      }
    }
    resolved.push({
      serviceId: item.serviceId ?? null,
      productId: item.productId ?? null,
      quantity: item.quantity,
      unitPrice,
      billable: item.billable !== false,
    });
  }
  return resolved;
}

/**
 * Crea una factura en draft con sus line items (snapshot de precios).
 * Factura C (monotributo): sin IVA discriminado, tax_amount = 0.
 */
export async function createDraftInvoice(
  db: Db,
  arca: ArcaConfig,
  input: {
    customerId: string;
    items: DraftItemInput[];
    adjustmentAmount?: number;
    description?: string;
  },
) {
  const customer = await getCustomerById(db, input.customerId);
  if (!customer) throw notFound("Customer");
  if (input.items.length === 0) throw badRequest("La factura necesita al menos un ítem");

  const items = await resolveItems(db, input.items);
  const subtotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const adjustment = input.adjustmentAmount ?? 0;
  const total = subtotal + adjustment;

  return db.transaction(async (tx) => {
    const invoice = await insertInvoice(tx, {
      customerId: input.customerId,
      issuerId: arca.issuerId,
      invoiceType: arca.invoiceType,
      subtotal: subtotal.toFixed(2),
      taxAmount: "0.00",
      adjustmentAmount: adjustment ? adjustment.toFixed(2) : null,
      totalAmount: total.toFixed(2),
      description: input.description ?? null,
      status: "draft",
      invoiceDate: new Date(),
    });
    await insertLineItems(
      tx,
      items.map((i) => ({
        invoiceId: invoice.id,
        serviceId: i.serviceId,
        productId: i.productId,
        quantity: i.quantity,
        unitPrice: i.unitPrice.toFixed(2),
        taxAmount: "0.00",
        subtotal: (i.unitPrice * i.quantity).toFixed(2),
        totalAmount: (i.unitPrice * i.quantity).toFixed(2),
      })),
    );
    return invoice;
  });
}

/** Pide CAE a ARCA y pasa la factura de draft a emitted. */
export async function emitInvoice(db: Db, env: AppBindings, invoiceId: string) {
  const invoice = await getInvoiceById(db, invoiceId);
  if (!invoice) throw notFound("Invoice");
  if (invoice.status !== "draft") {
    throw conflict(`Solo se emiten facturas en draft (actual: ${invoice.status})`);
  }

  // Cada factura se emite con SU facturador (el elegido en la cobranza), no con
  // uno global: distinto CUIT, certificado, punto de venta y numeración.
  const arca = await resolveArcaConfig(db, env, invoice.issuerId);
  const invoiceNumber = await getNextInvoiceNumber(
    db,
    invoice.invoiceType ?? arca.invoiceType,
    invoice.issuerId,
  );
  const result = await arca.client.emitInvoice({
    pointOfSale: arca.pointOfSale,
    invoiceType: invoice.invoiceType ?? arca.invoiceType,
    invoiceNumber,
    totalAmount: Number(invoice.totalAmount ?? 0),
    invoiceDate: invoice.invoiceDate ?? new Date(),
    customer: {
      docType: invoice.customerDni ? "DNI" : "CONSUMIDOR_FINAL",
      docNumber: invoice.customerDni ?? null,
      name: invoice.customerName ?? null,
    },
  });

  if (!result.ok) {
    const previousLogs = await getArcaLogsForInvoice(db, invoiceId);
    const failedCount = previousLogs.filter((l) => l.status === "failed").length;
    await insertArcaLog(db, {
      invoiceId,
      arcaResponseCode: result.errorCode,
      arcaFullResponse: result.rawResponse,
      retryCount: failedCount + 1,
      lastRetryAt: new Date(),
      status: "failed",
    });
    throw badGateway(`ARCA rechazó la factura: ${result.errorMessage}`);
  }

  return db.transaction(async (tx) => {
    const updated = await updateInvoice(tx, invoiceId, {
      invoiceNumber: result.invoiceNumber,
      status: "emitted",
      emittedAt: new Date(),
    });
    await insertArcaLog(tx, {
      invoiceId,
      cae: result.cae,
      caeExpiry: result.caeExpiry,
      arcaResponseCode: "ok",
      arcaFullResponse: result.rawResponse,
      retryCount: 0,
      status: "success",
    });
    return updated!;
  });
}

/**
 * Emisión en lote (ej: todos los drafts el viernes a la tarde).
 * Secuencial a propósito: mantiene la correlatividad de numeración.
 */
export async function emitBatch(db: Db, env: AppBindings, invoiceIds?: string[]) {
  const ids = invoiceIds ?? (await listDraftInvoiceIds(db));
  const results: { invoiceId: string; ok: boolean; cae?: string; invoiceNumber?: number; error?: string }[] = [];
  for (const id of ids) {
    try {
      const invoice = await emitInvoice(db, env, id);
      const logs = await getArcaLogsForInvoice(db, id);
      const lastSuccess = logs.filter((l) => l.status === "success").pop();
      results.push({
        invoiceId: id,
        ok: true,
        cae: lastSuccess?.cae ?? undefined,
        invoiceNumber: invoice.invoiceNumber ?? undefined,
      });
    } catch (err) {
      results.push({
        invoiceId: id,
        ok: false,
        error: err instanceof Error ? err.message : "Error desconocido",
      });
    }
  }
  return { results };
}

/**
 * Anula un comprobante. Las emitidas requieren nota de crédito en ARCA;
 * la factura queda visible como "cancelled", nunca se borra.
 */
export async function cancelInvoice(
  db: Db,
  env: AppBindings,
  invoiceId: string,
  reason?: string,
) {
  const invoice = await getInvoiceById(db, invoiceId);
  if (!invoice) throw notFound("Invoice");
  if (invoice.status === "cancelled") throw conflict("La factura ya está anulada");

  if (invoice.status === "draft") {
    return updateInvoice(db, invoiceId, { status: "cancelled" });
  }

  // La nota de crédito la tiene que emitir el MISMO facturador que la factura.
  const arca = await resolveArcaConfig(db, env, invoice.issuerId);

  const result = await arca.client.issueCreditNote({
    pointOfSale: arca.pointOfSale,
    originalInvoiceType: invoice.invoiceType ?? arca.invoiceType,
    originalInvoiceNumber: invoice.invoiceNumber ?? 0,
    totalAmount: Number(invoice.totalAmount ?? 0),
    reason,
  });

  if (!result.ok) {
    await insertArcaLog(db, {
      invoiceId,
      arcaResponseCode: result.errorCode,
      arcaFullResponse: result.rawResponse,
      retryCount: 1,
      lastRetryAt: new Date(),
      status: "failed",
    });
    throw badGateway(`ARCA rechazó la nota de crédito: ${result.errorMessage}`);
  }

  return db.transaction(async (tx) => {
    const updated = await updateInvoice(tx, invoiceId, { status: "cancelled" });
    await insertArcaLog(tx, {
      invoiceId,
      cae: result.cae,
      caeExpiry: result.caeExpiry,
      arcaResponseCode: "ok",
      arcaFullResponse: result.rawResponse,
      retryCount: 0,
      status: "success",
    });
    return updated!;
  });
}

export async function getInvoiceDetail(db: Db, invoiceId: string) {
  const invoice = await getInvoiceById(db, invoiceId);
  if (!invoice) throw notFound("Invoice");
  const [items, logs] = await Promise.all([
    getInvoiceLineItems(db, invoiceId),
    getArcaLogsForInvoice(db, invoiceId),
  ]);
  return { ...invoice, lineItems: items, arcaLogs: logs };
}

export { listInvoices };
