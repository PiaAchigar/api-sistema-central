import type { Db } from "../db/client";
import { localDayRangeUtc } from "../lib/time";
import { listAppointmentsByRange } from "../repositories/appointments.repo";

/**
 * Liquidación de comisiones: suma de provider_earning (snapshot congelado al
 * completar cada turno) por proveedora en un rango de fechas locales.
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

  return {
    from,
    to,
    rows,
    totalsByProvider: [...byProvider.values()].map((t) => ({
      ...t,
      total: Math.round(t.total * 100) / 100,
    })),
  };
}
