import type { ArcaConfig } from "../arca/factory";
import type { Db } from "../db/client";
import { badRequest, conflict, notFound } from "../lib/errors";
import {
  getAppointmentById,
  updateAppointment,
} from "../repositories/appointments.repo";
import { insertCashMovement } from "../repositories/cash.repo";
import { getCustomerById } from "../repositories/customers.repo";
import { insertInvoice, insertLineItems } from "../repositories/invoices.repo";
import { insertPayment } from "../repositories/payments.repo";
import { computeProviderEarning } from "./appointments.service";
import { resolveItems, type DraftItemInput } from "./invoicing.service";

export type CheckoutInput = {
  customerId: string;
  /** Facturador elegido para esta cobranza. Si no viene, el marcado por defecto. */
  issuerId?: string;
  /** Turno que se está cobrando (se marca completed con snapshot de comisión). */
  appointmentId?: string;
  items: DraftItemInput[];
  payment: {
    method: "cash" | "bank_transfer" | "mercadopago";
    amount: number;
    /** Tilde "lleva factura": genera factura draft para emitir (ahora o en lote). */
    wantsInvoice: boolean;
    /** Si el cliente transfirió directo a la profesional, no se factura a PiuBella. */
    paidToProviderId?: string;
  };
  notes?: string;
};

/**
 * Cobranza orquestada en una transacción:
 *  - "lleva factura" → INVOICE draft (tipo C) SOLO con los ítems marcados como
 *    facturables (`billable`); lo no facturable queda como pago no declarado
 *  - mixto (ítems ARCA + no ARCA) → dos PAYMENT: uno declarado con la factura
 *    y otro no declarado por el resto, cada uno con su movimiento de caja
 *  - efectivo → siempre movimiento en CASH_REGISTER (declarado según el ítem)
 *  - transferido a la profesional → PAYMENT con referencia, sin factura a PiuBella
 *  - turno asociado → pasa a completed y congela provider_earning
 */
export async function checkout(db: Db, arca: ArcaConfig, input: CheckoutInput) {
  const customer = await getCustomerById(db, input.customerId);
  if (!customer) throw notFound("Customer");
  if (input.payment.amount <= 0) throw badRequest("El monto debe ser mayor a cero");

  const paidToProvider = input.payment.paidToProviderId ?? null;

  if (input.payment.wantsInvoice && !paidToProvider && input.items.length === 0) {
    throw badRequest("Para facturar se necesita al menos un ítem");
  }
  const items = input.items.length > 0 ? await resolveItems(db, input.items) : [];

  const billableItems = items.filter((i) => i.billable);
  const wantsInvoice =
    input.payment.wantsInvoice && !paidToProvider && billableItems.length > 0;

  // Snapshot de comisión calculado fuera de la transacción (solo lecturas).
  // La comisión de la proveedora se muestra como desglose informativo en el
  // front, pero NO se descuenta de la factura: se factura el precio completo.
  let appointmentSnapshot: Record<string, unknown> | null = null;
  if (input.appointmentId) {
    const appt = await getAppointmentById(db, input.appointmentId);
    if (!appt) throw notFound("Appointment");
    if (appt.status === "cancelled" || appt.status === "no_show") {
      throw conflict("No se puede cobrar un turno cancelado o ausente");
    }
    appointmentSnapshot =
      appt.status === "completed" ? {} : await computeProviderEarning(db, appt);
  }

  const now = new Date();
  return db.transaction(async (tx) => {
    let invoice = null;
    if (wantsInvoice) {
      const subtotal = billableItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
      invoice = await insertInvoice(tx, {
        customerId: input.customerId,
        issuerId: arca.issuerId,
        invoiceType: arca.invoiceType,
        subtotal: subtotal.toFixed(2),
        taxAmount: "0.00",
        totalAmount: subtotal.toFixed(2),
        description: input.notes ?? null,
        status: "draft",
        invoiceDate: now,
      });
      await insertLineItems(
        tx,
        billableItems.map((i) => ({
          invoiceId: invoice!.id,
          serviceId: i.serviceId,
          productId: i.productId,
          quantity: i.quantity,
          unitPrice: i.unitPrice.toFixed(2),
          taxAmount: "0.00",
          subtotal: (i.unitPrice * i.quantity).toFixed(2),
          totalAmount: (i.unitPrice * i.quantity).toFixed(2),
        })),
      );
    }

    // Split del pago: la parte facturada queda declarada; el resto (ítems sin
    // ARCA, o todo si no lleva factura) queda como pago no declarado aparte.
    const billableTotal = billableItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    const declaredAmount = wantsInvoice ? Math.min(billableTotal, input.payment.amount) : 0;
    const undeclaredAmount = input.payment.amount - declaredAmount;

    const insertPart = (amount: number, declared: boolean, inv: typeof invoice) =>
      insertPayment(tx, {
        invoiceId: inv?.id ?? null,
        appointmentId: input.appointmentId ?? null,
        amount: amount.toFixed(2),
        paymentMethod: input.payment.method,
        status: "confirmed",
        paymentDate: now,
        isDeclared: declared,
        receivedByProviderId: paidToProvider,
        notes: input.notes ?? null,
        confirmedAt: now,
      });

    const payment =
      declaredAmount > 0
        ? await insertPart(declaredAmount, true, invoice)
        : await insertPart(undeclaredAmount, false, null);
    const undeclaredPayment =
      declaredAmount > 0 && undeclaredAmount > 0
        ? await insertPart(undeclaredAmount, false, null)
        : null;

    const cashMovements = [];
    if (input.payment.method === "cash" && !paidToProvider) {
      for (const p of [payment, undeclaredPayment]) {
        if (!p) continue;
        const declared = p.isDeclared === true;
        cashMovements.push(
          await insertCashMovement(tx, {
            paymentId: p.id,
            amount: p.amount,
            source: "customer_payment",
            description: `Cobro a ${customer.name ?? "cliente"}${declared ? " (facturable)" : ""}`,
            isDeclared: declared,
            status: "recorded",
            registrationDate: now,
          }),
        );
      }
    }

    let appointment = null;
    if (input.appointmentId && appointmentSnapshot) {
      appointment = await updateAppointment(tx, input.appointmentId, {
        status: "completed",
        ...appointmentSnapshot,
      });
    }

    return {
      payment,
      undeclaredPayment,
      invoice,
      cashMovement: cashMovements[0] ?? null,
      appointment,
    };
  });
}
