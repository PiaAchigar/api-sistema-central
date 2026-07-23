import type { Db } from "../db/client";
import { localDayRangeUtc } from "../lib/time";
import { listAppointmentsByRange } from "../repositories/appointments.repo";
import { sumPaymentsReceivedByProvider } from "../repositories/payments.repo";

/**
 * Liquidación de comisiones: suma de provider_earning (snapshot congelado al
 * completar cada turno) por proveedora en un rango de fechas locales.
 * Incluye la rendición: comisiones ganadas − cobrado directo por la
 * profesional (transferencias que nunca entraron a PiuBella) = saldo a pagar.
 */
export async function getCommissionsReport(
  db: Db,
  from: string,
  to: string,
  providerId?: string,
) {
  const range = {
    start: localDayRangeUtc(from).start,
    end: localDayRangeUtc(to).end,
  };
  const appointments = await listAppointmentsByRange(db, range, {
    providerId,
    status: "completed",
  });

  const rows = appointments
    .filter((a) => a.providerEarning != null)
    .map((a) => ({
      appointmentId: a.id,
      date: a.appointmentStart,
      customerName: a.customerName,
      serviceName: a.serviceName,
      servicePrice: Number(a.servicePrice ?? 0),
      providerId: a.providerId,
      providerName: a.providerName,
      paymentType: a.providerPaymentType,
      rate: Number(a.providerRate ?? 0),
      earning: Number(a.providerEarning ?? 0),
    }));

  const byProvider = new Map<string, { providerId: string; name: string; total: number }>();
  for (const row of rows) {
    if (!row.providerId) continue;
    const entry = byProvider.get(row.providerId) ?? {
      providerId: row.providerId,
      name: row.providerName ?? "",
      total: 0,
    };
    entry.total += row.earning;
    byProvider.set(row.providerId, entry);
  }

  // Rendición: lo cobrado directo por cada profesional en el mismo período se
  // descuenta de sus comisiones. Saldo > 0 ⇒ PiuBella le paga; < 0 ⇒ la
  // profesional cobró de más y debe la diferencia.
  const received = await sumPaymentsReceivedByProvider(db, range);
  if (providerId) {
    // El filtro por profesional también aplica a la rendición
    received.splice(0, received.length, ...received.filter((r) => r.providerId === providerId));
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const settlementIds = new Set<string>([
    ...byProvider.keys(),
    ...received.map((r) => r.providerId).filter((id): id is string => id != null),
  ]);
  const settlement = [...settlementIds].map((id) => {
    const commissions = byProvider.get(id)?.total ?? 0;
    const receivedRow = received.find((r) => r.providerId === id);
    const receivedDirect = Number(receivedRow?.total ?? 0);
    return {
      providerId: id,
      name: byProvider.get(id)?.name ?? receivedRow?.providerName ?? "",
      commissions: round(commissions),
      receivedDirect: round(receivedDirect),
      balance: round(commissions - receivedDirect),
    };
  });

  return {
    from,
    to,
    rows,
    totalsByProvider: [...byProvider.values()].map((t) => ({
      ...t,
      total: round(t.total),
    })),
    settlement,
  };
}
