import type { ArcaConfig } from "../arca/factory";
import type { Db } from "../db/client";
import { badRequest } from "../lib/errors";
import { insertCashMovement } from "../repositories/cash.repo";
import { getOpenDealByContactId, insertDeal, updateDealFromDeposit } from "../repositories/deals.repo";
import { insertInvoice, insertLineItems } from "../repositories/invoices.repo";
import { insertPayment } from "../repositories/payments.repo";
import { debitCustomerCredit } from "../repositories/customers.repo";
import { updateAppointment } from "../repositories/appointments.repo";

export type DepositInput = {
  amount: number;
  /** "credit" = se paga con el saldo a favor del cliente (no entra plata nueva). */
  method: "cash" | "bank_transfer" | "mercadopago" | "credit";
};

type Tx = Pick<Db, "select" | "insert" | "update">;

/**
 * Registra la SEÑA de un turno (dentro de la transacción de creación):
 *  - DEAL con senia_amount/senia_paid (la cuenta corriente del turno)
 *  - la seña se factura SIEMPRE a ARCA (la plata entra a PiuBella):
 *    INVOICE draft tipo C con un line item del servicio por el monto señado
 *  - PAYMENT confirmado y declarado + movimiento de caja si fue en efectivo
 *  - appointments.deal_id queda apuntando al deal
 *
 * Excepción: si se paga con SALDO A FAVOR (`method: "credit"`) no entra plata
 * nueva — es plata que el cliente ya pagó y que ya se facturó cuando se cobró
 * la seña original, antes de que ese turno se cancelara. Por eso ese caso NO
 * emite factura ni mueve la caja: solo descuenta el saldo y deja el pago
 * registrado para que el turno figure señado.
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
  const paidWithCredit = deposit.method === "credit";

  const existingDeal = params.contactId
    ? await getOpenDealByContactId(tx, params.contactId)
    : null;

  const deal = existingDeal
    ? await updateDealFromDeposit(tx, existingDeal.id, {
        appointmentId: params.appointmentId,
        serviceName: params.serviceName,
        servicePrice: params.servicePrice.toFixed(2),
        seniaAmount: deposit.amount.toFixed(2),
        seniaPaid: true,
        seniaPaidDate: now,
        stage: "senia_pagada",
      })
    : await insertDeal(tx, {
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
        stage: "senia_pagada",
      });

  await updateAppointment(tx, params.appointmentId, { dealId: deal.id });

  // Pagada con saldo a favor: esa plata ya entró y ya se facturó en su momento,
  // así que acá no se emite comprobante nuevo (sería facturar dos veces).
  const invoice = paidWithCredit
    ? null
    : await insertInvoice(tx, {
        customerId: params.customerId,
        issuerId: arca.issuerId,
        invoiceType: arca.invoiceType,
        subtotal: deposit.amount.toFixed(2),
        taxAmount: "0.00",
        totalAmount: deposit.amount.toFixed(2),
        description: `Seña — ${params.serviceName ?? "servicio"}`,
        status: "draft",
        invoiceDate: now,
      });
  if (invoice) {
    await insertLineItems(tx, [
      {
        invoiceId: invoice.id,
        description: params.serviceName
          ? `Seña de servicio: ${params.serviceName}`
          : "Seña de servicio",
        serviceId: params.serviceId,
        quantity: 1,
        unitPrice: deposit.amount.toFixed(2),
        taxAmount: "0.00",
        subtotal: deposit.amount.toFixed(2),
        totalAmount: deposit.amount.toFixed(2),
      },
    ]);
  }

  const payment = await insertPayment(tx, {
    invoiceId: invoice?.id ?? null,
    customerId: params.customerId,
    appointmentId: params.appointmentId,
    amount: deposit.amount.toFixed(2),
    paymentMethod: deposit.method,
    status: "confirmed",
    paymentDate: now,
    // El saldo no es ingreso nuevo: ya se declaró al facturar la seña original.
    isDeclared: !paidWithCredit,
    notes: paidWithCredit
      ? `Seña de ${params.customerName ?? "cliente"} pagada con saldo a favor`
      : `Seña de ${params.customerName ?? "cliente"}`,
    confirmedAt: now,
  });

  // Sin factura no hay línea de detalle, y la seña aparecería sin concepto en la
  // rendición de caja. Se cuelga del pago, igual que los ítems no facturados.
  if (paidWithCredit) {
    await insertLineItems(tx, [
      {
        paymentId: payment.id,
        description: params.serviceName
          ? `Seña de servicio: ${params.serviceName} (saldo a favor)`
          : "Seña de servicio (saldo a favor)",
        serviceId: params.serviceId,
        quantity: 1,
        unitPrice: deposit.amount.toFixed(2),
        taxAmount: "0.00",
        subtotal: deposit.amount.toFixed(2),
        totalAmount: deposit.amount.toFixed(2),
      },
    ]);
  }

  // Descuento del saldo: si no alcanza, revienta la transacción entera y el
  // turno no se crea (mejor eso que un turno señado sin respaldo).
  if (paidWithCredit) {
    const ok = await debitCustomerCredit(tx, params.customerId, deposit.amount, {
      reason: "deposit_paid_with_credit",
      appointmentId: params.appointmentId,
      paymentId: payment.id,
      notes: `Seña de ${params.serviceName ?? "servicio"}`,
    });
    if (!ok) throw badRequest("El saldo a favor del cliente no alcanza para esta seña.");
  }

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
