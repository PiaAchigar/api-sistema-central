import type { Db } from "../db/client";
import { badRequest } from "../lib/errors";
import { localDayRangeUtc } from "../lib/time";
import { insertCashMovement, listCashMovementsByRange } from "../repositories/cash.repo";
import { listItemsForPayments, listPaymentsByRange } from "../repositories/payments.repo";

export async function listCashMovements(db: Db, date: string) {
  return listCashMovementsByRange(db, localDayRangeUtc(date));
}

export async function addManualCashMovement(
  db: Db,
  input: {
    amount: number;
    source: "deposit" | "refund" | "other";
    description: string;
    isDeclared: boolean;
  },
) {
  if (input.amount === 0) throw badRequest("El monto no puede ser cero");
  return insertCashMovement(db, {
    amount: input.amount.toFixed(2),
    source: input.source,
    description: input.description,
    isDeclared: input.isDeclared,
    status: "recorded",
    registrationDate: new Date(),
  });
}

/**
 * Rendición de caja del día: todos los movimientos (pagos + caja manual),
 * totales por método de pago y desglose declarado vs no declarado.
 * Pensada para visualizar antes de imprimir.
 */
export async function getDailyReport(db: Db, date: string) {
  const range = localDayRangeUtc(date);
  const [payments, cashMovements] = await Promise.all([
    listPaymentsByRange(db, range),
    listCashMovementsByRange(db, range),
  ]);

  // Qué servicios/productos se cobraron en cada pago, para nombrarlos en la
  // rendición (incluye los NO facturados, que solo viven como línea del cobro).
  const itemRows = await listItemsForPayments(
    db,
    payments.map((p) => p.id),
    payments.map((p) => p.invoiceId).filter((id): id is string => Boolean(id)),
  );
  const itemsByPayment = new Map<string, string[]>();
  for (const p of payments) {
    const mine = itemRows.filter((r) =>
      r.paymentId ? r.paymentId === p.id : p.invoiceId && r.invoiceId === p.invoiceId,
    );
    const labels = mine.map((r) => {
      const name = r.description ?? r.serviceName ?? r.productName ?? "Ítem";
      return (r.quantity ?? 1) > 1 ? `${name} ×${r.quantity}` : name;
    });
    if (labels.length) itemsByPayment.set(p.id, labels);
  }

  const totalsByMethod = { cash: 0, bank_transfer: 0, mercadopago: 0 };
  let declared = 0;
  let undeclared = 0;
  let paidToProviders = 0;

  for (const p of payments) {
    const amount = Number(p.amount ?? 0);
    // Pagado con saldo a favor: no entró ni salió plata hoy (esa plata ya se
    // cobró y se declaró cuando se facturó la seña original). Se lista en el
    // detalle pero no suma a ningún total de caja.
    if (p.paymentMethod === "credit") continue;
    if (p.receivedByProviderId) {
      // Dinero que nunca entró a PiuBella: se lista pero no suma a la caja
      paidToProviders += amount;
      continue;
    }
    const method = (p.paymentMethod ?? "cash") as keyof typeof totalsByMethod;
    if (method in totalsByMethod) totalsByMethod[method] += amount;
    if (p.isDeclared) declared += amount;
    else undeclared += amount;
  }

  // Movimientos manuales de caja (sin payment asociado, para no duplicar)
  for (const m of cashMovements) {
    if (m.paymentId) continue;
    const amount = Number(m.amount ?? 0);
    totalsByMethod.cash += amount;
    if (m.isDeclared) declared += amount;
    else undeclared += amount;
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    date,
    payments: payments.map((p) => ({ ...p, items: itemsByPayment.get(p.id) ?? [] })),
    cashMovements,
    totalsByMethod: {
      cash: round(totalsByMethod.cash),
      bank_transfer: round(totalsByMethod.bank_transfer),
      mercadopago: round(totalsByMethod.mercadopago),
    },
    declared: round(declared),
    undeclared: round(undeclared),
    paidToProviders: round(paidToProviders),
    grandTotal: round(declared + undeclared),
  };
}
