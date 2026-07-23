import type { ArcaConfig } from "../arca/factory";
import type { Db } from "../db/client";
import { badRequest } from "../lib/errors";
import { insertCashMovement } from "../repositories/cash.repo";
import { insertDeal } from "../repositories/deals.repo";
import { insertInvoice, insertLineItems } from "../repositories/invoices.repo";
import { insertPayment } from "../repositories/payments.repo";
import { updateAppointment } from "../repositories/appointments.repo";

export type DepositInput = {
  amount: number;
  method: "cash" | "bank_transfer" | "mercadopago";
};

type Tx = Pick<Db, "select" | "insert" | "update">;

/**
 * Registra la SEÑA de un turno (dentro de la transacción de creación):
 *  - DEAL con senia_amount/senia_paid (la cuenta corriente del turno)
 *  - la seña se factura SIEMPRE a ARCA (la plata entra a PiuBella):
 *    INVOICE draft tipo C con un line item del servicio por el monto señado
 *  - PAYMENT confirmado y declarado + movimiento de caja si fue en efectivo
 *  - appointments.deal_id queda apuntando al deal
 */
export async function registerDeposit(
  tx: Tx,
  arca: ArcaConfig,
  params: {
    appointmentId: string;
    customerId: string;
    contactId: string | null;
    customerName: string | null;
    serviceId: string;
    serviceName: string | null;
    servicePrice: number;
    deposit: DepositInput;
  },
) {
  const { deposit } = params;
  if (deposit.amount <= 0) throw badRequest("La seña debe ser mayor a cero");
  if (params.servicePrice > 0 && deposit.amount > params.servicePrice) {
    throw badRequest("La seña no puede superar el precio del servicio");
  }

  const now = new Date();

  const deal = await insertDeal(tx, {
    contactId: params.contactId,
    appointmentId: params.appointmentId,
    title: `Seña — ${params.serviceName ?? "servicio"}`,
    serviceName: params.serviceName,
    servicePrice: params.servicePrice.toFixed(2),
    seniaAmount: deposit.amount.toFixed(2),
    seniaPaid: true,
    seniaPaidDate: now,
    totalAmount: params.servicePrice.toFixed(2),
    amountPaid: deposit.amount.toFixed(2),
    amountPending: Math.max(0, params.servicePrice - deposit.amount).toFixed(2),
    paymentMethod: deposit.method,
    cancelled: false,
  });

  await updateAppointment(tx, params.appointmentId, { dealId: deal.id });

  const invoice = await insertInvoice(tx, {
    customerId: params.customerId,
    invoiceType: arca.invoiceType,
    subtotal: deposit.amount.toFixed(2),
    taxAmount: "0.00",
    totalAmount: deposit.amount.toFixed(2),
    description: `Seña — ${params.serviceName ?? "servicio"}`,
    status: "draft",
    invoiceDate: now,
  });
  await insertLineItems(tx, [
    {
      invoiceId: invoice.id,
      serviceId: params.serviceId,
      quantity: 1,
      unitPrice: deposit.amount.toFixed(2),
      taxAmount: "0.00",
      subtotal: deposit.amount.toFixed(2),
      totalAmount: deposit.amount.toFixed(2),
    },
  ]);

  const payment = await insertPayment(tx, {
    invoiceId: invoice.id,
    appointmentId: params.appointmentId,
    amount: deposit.amount.toFixed(2),
    paymentMethod: deposit.method,
    status: "confirmed",
    paymentDate: now,
    isDeclared: true,
    notes: `Seña de ${params.customerName ?? "cliente"}`,
    confirmedAt: now,
  });

  let cashMovement = null;
  if (deposit.method === "cash") {
    cashMovement = await insertCashMovement(tx, {
      paymentId: payment.id,
      amount: deposit.amount.toFixed(2),
      source: "customer_payment",
      description: `Seña de ${params.customerName ?? "cliente"} (facturable)`,
      isDeclared: true,
      status: "recorded",
      registrationDate: now,
    });
  }

  return { deal, invoice, payment, cashMovement };
}
