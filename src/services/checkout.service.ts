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
 *  - "lleva factura" → INVOICE draft (tipo C) + PAYMENT is_declared=true
 *  - efectivo → siempre movimiento en CASH_REGISTER (declarado según el tilde)
 *  - transferido a la profesional → PAYMENT con referencia, sin factura a PiuBella
 *  - turno asociado → pasa a completed y congela provider_earning
 */
export async function checkout(db: Db, arca: ArcaConfig, input: CheckoutInput) {
  const customer = await getCustomerById(db, input.customerId);
  if (!customer) throw notFound("Customer");
  if (input.payment.amount <= 0) throw badRequest("El monto debe ser mayor a cero");

  const paidToProvider = input.payment.paidToProviderId ?? null;
  const wantsInvoice = input.payment.wantsInvoice && !paidToProvider;

  if (wantsInvoice && input.items.length === 0) {
    throw badRequest("Para facturar se necesita al menos un ítem");
  }
  const items = input.items.length > 0 ? await resolveItems(db, input.items) : [];

  // Snapshot de comisión calculado fuera de la transacción (solo lecturas)
  let appointmentSnapshot: Record<string, unknown> | null = null;
  let providerEarning = 0;
  let appointmentServiceId: string | null = null;
  if (input.appointmentId) {
    const appt = await getAppointmentById(db, input.appointmentId);
    if (!appt) throw notFound("Appointment");
    if (appt.status === "cancelled" || appt.status === "no_show") {
      throw conflict("No se puede cobrar un turno cancelado o ausente");
    }
    appointmentSnapshot =
      appt.status === "completed" ? {} : await computeProviderEarning(db, appt);
    // Si el turno ya estaba completado, la comisión ya quedó congelada antes
    // (vía "Completar" en la agenda) y computeProviderEarning no la recalcula.
    providerEarning = Number(
      appt.status === "completed"
        ? (appt.providerEarning ?? 0)
        : ((appointmentSnapshot as { providerEarning?: string }).providerEarning ?? 0),
    );
    appointmentServiceId = appt.serviceId;
  }

  // Lo que cobra la profesional por este turno (service_provider_service) no
  // es ingreso de PiuBella: se descuenta del ítem facturado al cliente. El
  // monto que el cliente paga en mano (payment.amount) no se toca.
  if (providerEarning > 0 && appointmentServiceId) {
    const idx = items.findIndex((i) => i.serviceId === appointmentServiceId);
    const item = idx !== -1 ? items[idx] : undefined;
    if (item) {
      const earningPerUnit = providerEarning / item.quantity;
      items[idx] = { ...item, unitPrice: Math.max(0, item.unitPrice - earningPerUnit) };
    }
  }

  const now = new Date();
  return db.transaction(async (tx) => {
    let invoice = null;
    if (wantsInvoice) {
      const subtotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
      invoice = await insertInvoice(tx, {
        customerId: input.customerId,
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
        items.map((i) => ({
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

    const payment = await insertPayment(tx, {
      invoiceId: invoice?.id ?? null,
      amount: input.payment.amount.toFixed(2),
      paymentMethod: input.payment.method,
      status: "confirmed",
      paymentDate: now,
      isDeclared: wantsInvoice,
      receivedByProviderId: paidToProvider,
      notes: input.notes ?? null,
      confirmedAt: now,
    });

    let cashMovement = null;
    if (input.payment.method === "cash" && !paidToProvider) {
      cashMovement = await insertCashMovement(tx, {
        paymentId: payment.id,
        amount: input.payment.amount.toFixed(2),
        source: "customer_payment",
        description: `Cobro a ${customer.name ?? "cliente"}${wantsInvoice ? " (facturable)" : ""}`,
        isDeclared: wantsInvoice,
        status: "recorded",
        registrationDate: now,
      });
    }

    let appointment = null;
    if (input.appointmentId && appointmentSnapshot) {
      appointment = await updateAppointment(tx, input.appointmentId, {
        status: "completed",
        ...appointmentSnapshot,
      });
    }

    return { payment, invoice, cashMovement, appointment };
  });
}
