import type { Db } from "../db/client";
import { badRequest, conflict, notFound } from "../lib/errors";
import { subtractAll, type Interval } from "../lib/intervals";
import { localDayRangeUtc, utcToLocalDateString, utcToLocalMinutes } from "../lib/time";
import {
  getAppointmentById,
  getOverlappingAppointments,
  insertAppointment,
  listAppointmentsByRange,
  updateAppointment,
} from "../repositories/appointments.repo";
import { getCustomerById } from "../repositories/customers.repo";
import { getActiveAgreement } from "../repositories/providers.repo";
import { getServiceById } from "../repositories/services.repo";
import { loadAvailabilityContext } from "./availability.service";

export type CreateAppointmentInput = {
  customerId: string;
  serviceId: string;
  providerId: string;
  machineId?: string;
  start: string; // ISO datetime
  priceMode?: "list" | "cash";
  notes?: string;
};

export async function createAppointment(db: Db, input: CreateAppointmentInput) {
  const startDate = new Date(input.start);
  if (Number.isNaN(startDate.getTime())) throw badRequest("Fecha de inicio inválida");
  if (startDate.getTime() < Date.now()) throw badRequest("El turno no puede ser en el pasado");

  const customer = await getCustomerById(db, input.customerId);
  if (!customer) throw notFound("Customer");

  const localDate = utcToLocalDateString(startDate);
  // El contexto ya valida: proveedora activa con acuerdo vigente, horario del local,
  // disponibilidad del día (semana/sábado), excepciones y turnos existentes.
  const ctx = await loadAvailabilityContext(db, input.serviceId, localDate, input.providerId);
  if (!ctx.open) throw conflict("El local está cerrado ese día");
  if (ctx.providers.length === 0) {
    throw conflict("La proveedora no está disponible para este servicio en esa fecha");
  }

  const startMin = utcToLocalMinutes(startDate);
  const requested: Interval = { start: startMin, end: startMin + ctx.durationMinutes };
  const endDate = new Date(startDate.getTime() + ctx.durationMinutes * 60 * 1000);

  const freeWindows = ctx.freeWindowsByProvider.get(input.providerId) ?? [];
  const fitsProvider = freeWindows.some(
    (w) => requested.start >= w.start && requested.end <= w.end,
  );
  if (!fitsProvider) {
    throw conflict("La proveedora no tiene ese horario disponible");
  }

  // Máquina: la pedida debe estar certificada y libre; si no se pidió, se elige
  // automáticamente la primera certificada libre (primaria primero)
  let machineId: string | null = null;
  if (ctx.requiresMachine) {
    const candidates = ctx.machinesByProvider.get(input.providerId) ?? [];
    const isMachineFree = (mid: string) => {
      const free = subtractAll(freeWindows, ctx.busyByMachine.get(mid) ?? []);
      return free.some((w) => requested.start >= w.start && requested.end <= w.end);
    };
    if (input.machineId) {
      if (!candidates.includes(input.machineId)) {
        throw conflict("La proveedora no está certificada en esa máquina");
      }
      if (!isMachineFree(input.machineId)) {
        throw conflict("La máquina está ocupada en ese horario");
      }
      machineId = input.machineId;
    } else {
      machineId = candidates.find(isMachineFree) ?? null;
      if (!machineId) throw conflict("No hay máquina disponible en ese horario");
    }
  }

  const servicePrice =
    input.priceMode === "cash" ? ctx.service.unitPriceCash : ctx.service.unitPriceList;

  // Re-chequeo de solapamiento dentro de la transacción para mitigar carreras
  return db.transaction(async (tx) => {
    const providerClash = await getOverlappingAppointments(
      tx,
      { providerId: input.providerId },
      startDate,
      endDate,
    );
    if (providerClash.length > 0) {
      throw conflict("El horario acaba de ser tomado por otro turno");
    }
    if (machineId) {
      const machineClash = await getOverlappingAppointments(
        tx,
        { machineId },
        startDate,
        endDate,
      );
      if (machineClash.length > 0) {
        throw conflict("La máquina acaba de ser tomada por otro turno");
      }
    }

    return insertAppointment(tx, {
      customerId: input.customerId,
      serviceProviderId: input.providerId,
      serviceId: input.serviceId,
      machineId,
      appointmentStart: startDate,
      appointmentEnd: endDate,
      durationMinutes: ctx.durationMinutes,
      servicePrice,
      status: "scheduled",
      notes: input.notes ?? null,
    });
  });
}

export async function listAppointmentsByDay(
  db: Db,
  date: string,
  filters: { providerId?: string; status?: string },
) {
  return listAppointmentsByRange(db, localDayRangeUtc(date), filters);
}

const VALID_STATUSES = ["scheduled", "completed", "cancelled", "no_show"];

export async function updateAppointmentStatus(
  db: Db,
  id: string,
  changes: { status?: string; notes?: string },
) {
  const appt = await getAppointmentById(db, id);
  if (!appt) throw notFound("Appointment");

  const values: Record<string, unknown> = {};
  if (changes.notes !== undefined) values.notes = changes.notes;

  if (changes.status) {
    if (!VALID_STATUSES.includes(changes.status)) throw badRequest("Estado inválido");
    if (appt.status === "completed" && changes.status !== "completed") {
      throw conflict("Un turno completado no puede cambiar de estado");
    }
    values.status = changes.status;

    // Al completar se congela el snapshot de pago a la proveedora: si mañana
    // cambia el acuerdo, los turnos ya liquidados no se mueven.
    if (changes.status === "completed" && appt.status !== "completed") {
      const snapshot = await computeProviderEarning(db, appt);
      Object.assign(values, snapshot);
    }
  }

  return updateAppointment(db, id, values);
}

export async function computeProviderEarning(
  db: Db,
  appt: NonNullable<Awaited<ReturnType<typeof getAppointmentById>>>,
) {
  if (!appt.serviceProviderId || !appt.serviceId) return {};
  const agreement = await getActiveAgreement(db, appt.serviceProviderId, appt.serviceId);
  if (!agreement?.paymentType || agreement.rate == null) return {};

  const rate = Number(agreement.rate);
  const duration = appt.durationMinutes ?? 0;
  let earning: number;
  switch (agreement.paymentType) {
    case "per_hour":
      earning = (rate * duration) / 60;
      break;
    case "percentage": {
      // El porcentaje se calcula SIEMPRE sobre el precio en efectivo del servicio
      const svc = await getServiceById(db, appt.serviceId);
      earning = (rate / 100) * Number(svc?.unitPriceCash ?? 0);
      break;
    }
    case "fixed_per_service":
      earning = rate;
      break;
    default:
      return {};
  }

  return {
    providerPaymentType: agreement.paymentType,
    providerRate: agreement.rate,
    providerEarning: earning.toFixed(2),
  };
}
