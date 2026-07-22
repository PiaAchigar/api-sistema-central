import type { Db } from "../db/client";
import { localDayRangeUtc } from "../lib/time";
import { listAppointmentsByRange } from "../repositories/appointments.repo";
import { getPaidDealsByAppointmentIds } from "../repositories/deals.repo";
import { sumPaymentsByAppointmentIds } from "../repositories/payments.repo";

/**
 * Estado de cuenta de los clientes de un día: por cada turno, cuánto señaron
 * (dinero a favor), cuánto pagaron en total y cuánto falta cobrar. Pensado
 * para que en recepción se vea de un vistazo con qué saldo llega cada cliente.
 */
export async function getCustomerDayStatus(db: Db, date: string) {
  const range = localDayRangeUtc(date);
  const appointments = (await listAppointmentsByRange(db, range, {})).filter(
    (a) => a.status !== "cancelled",
  );

  const ids = appointments.map((a) => a.id);
  const [deals, paidSums] = await Promise.all([
    getPaidDealsByAppointmentIds(db, ids),
    sumPaymentsByAppointmentIds(db, ids),
  ]);

  const round = (n: number) => Math.round(n * 100) / 100;
  const rows = appointments.map((a) => {
    const deal = deals.find((d) => d.appointmentId === a.id) ?? null;
    const depositPaid = deal ? Number(deal.seniaAmount ?? 0) : 0;
    const totalPaid = Number(paidSums.find((p) => p.appointmentId === a.id)?.total ?? 0);
    const servicePrice = Number(a.servicePrice ?? 0);
    return {
      appointmentId: a.id,
      appointmentStart: a.appointmentStart,
      status: a.status,
      customerId: a.customerId,
      customerName: a.customerName,
      customerPhone: a.customerPhone,
      serviceName: a.serviceName,
      providerName: a.providerName,
      servicePrice: round(servicePrice),
      depositPaid: round(depositPaid),
      totalPaid: round(totalPaid),
      balanceDue: round(Math.max(0, servicePrice - totalPaid)),
    };
  });

  return {
    date,
    rows,
    totals: {
      deposits: round(rows.reduce((s, r) => s + r.depositPaid, 0)),
      paid: round(rows.reduce((s, r) => s + r.totalPaid, 0)),
      due: round(rows.reduce((s, r) => s + r.balanceDue, 0)),
    },
  };
}
