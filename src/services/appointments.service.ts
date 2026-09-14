import type { Db } from "../db/client";
import { badRequest, conflict, notFound } from "../lib/errors";
import { subtractAll, type Interval } from "../lib/intervals";
import {
  filaDeReagendado,
  huboMovimiento,
  type QuienYPorQue,
} from "../lib/reagendado";
import { localDayRangeUtc, utcToLocalDateString, utcToLocalMinutes } from "../lib/time";
import {
  getAppointmentById,
  getOverlappingAppointments,
  insertAppointment,
  listAppointmentsByRange,
  updateAppointment,
} from "../repositories/appointments.repo";
import { recordReschedule } from "../repositories/appointment-reschedule.repo";
import { creditCustomer, getCustomerById } from "../repositories/customers.repo";
import { cancelDeal, getDealByAppointmentId } from "../repositories/deals.repo";
import { getActiveAgreement } from "../repositories/providers.repo";
import { getServiceById } from "../repositories/services.repo";
import { loadAvailabilityContext } from "./availability.service";
import { consumirInsumos } from "./consumo.service";
import { consumirServicioDelTurno, tomarServicio } from "../repositories/consumo.repo";
import { registerDeposit, type DepositInput } from "./deposits.service";
import type { ArcaConfig } from "../arca/factory";

export type CreateAppointmentInput = {
  customerId: string;
  serviceId: string;
  providerId: string;
  machineId?: string;
  start: string; // ISO datetime
  priceMode?: "list" | "cash";
  notes?: string;
  status?: "scheduled" | "reserved";
  expiryMinutes?: number; // solo para status='reserved'; default 60
  /** Seña cobrada al reservar: se factura a ARCA y queda a favor del cliente. */
  deposit?: DepositInput;
  /**
   * El servicio comprado (sin fecha todavía) que este turno descuenta (V3b).
   *
   * Ausente = el turno no descuenta nada y se cobra aparte, que es el caso más
   * común. La pantalla lo completa sola cuando la clienta tiene UNA sola compra
   * con servicios libres para este servicio; con varias, lo elige Laura
   * (reglas §3.8). Al confirmarse el turno, ese servicio comprado pasa a ser
   * una sesión — recién ahí tiene fecha y hora.
   */
  customerPurchaseServiceId?: string;
};

export async function createAppointment(
  db: Db,
  input: CreateAppointmentInput,
  arca?: ArcaConfig,
) {
  if (input.deposit && !arca) throw badRequest("Config ARCA requerida para señas");
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

    const apptStatus = input.status ?? "scheduled";
    const reservationExpiresAt =
      apptStatus === "reserved"
        ? new Date(Date.now() + (input.expiryMinutes ?? 60) * 60_000)
        : null;

    const appointment = await insertAppointment(tx, {
      customerId: input.customerId,
      serviceProviderId: input.providerId,
      serviceId: input.serviceId,
      machineId,
      appointmentStart: startDate,
      appointmentEnd: endDate,
      durationMinutes: ctx.durationMinutes,
      servicePrice,
      status: apptStatus,
      reservationExpiresAt,
      notes: input.notes ?? null,
    });

    // Descontar el servicio comprado, si el turno viene atado a una compra.
    //
    // Va DENTRO de la transacción y con su propia guarda: entre que la pantalla
    // preguntó qué había disponible y el momento de guardar, otra persona pudo
    // haber agendado ese mismo servicio comprado. Sin el chequeo, la segunda
    // pisaría a la primera y el pack quedaría con una sesión de más.
    if (input.customerPurchaseServiceId) {
      await tomarServicio(tx, input.customerPurchaseServiceId, {
        appointmentId: appointment.id,
        customerId: input.customerId,
        serviceId: input.serviceId,
        ahora: new Date(),
      });
    }

    if (input.deposit && arca) {
      await registerDeposit(tx, arca, {
        appointmentId: appointment.id,
        customerId: input.customerId,
        contactId: customer.contactId ?? null,
        customerName: customer.name ?? null,
        serviceId: input.serviceId,
        serviceName: ctx.service.name ?? null,
        servicePrice: Number(servicePrice ?? 0),
        deposit: input.deposit,
      });
    }

    return appointment;
  });
}

export async function listAppointmentsByDay(
  db: Db,
  date: string,
  filters: { providerId?: string; status?: string },
) {
  return listAppointmentsByRange(db, localDayRangeUtc(date), filters);
}

const VALID_STATUSES = ["reserved", "scheduled", "completed", "cancelled", "no_show"];

export async function updateAppointmentStatus(
  db: Db,
  id: string,
  changes: { status?: string; notes?: string },
) {
  const appt = await getAppointmentById(db, id);
  if (!appt) throw notFound("Appointment");

  const values: Record<string, unknown> = {};
  if (changes.notes !== undefined) values.notes = changes.notes;

  /** Seña a devolver como saldo a favor al cancelar (null = no hay nada que acreditar). */
  let dealToCancel: { id: string; amount: number; customerId: string } | null = null;

  /** Sólo la TRANSICIÓN descuenta insumos. Volver a mandar 'completed' sobre un
   *  turno ya completado no descuenta de nuevo. */
  const completando = changes.status === "completed" && appt.status !== "completed";

  if (changes.status) {
    if (!VALID_STATUSES.includes(changes.status)) throw badRequest("Estado inválido");
    if (appt.status === "completed" && changes.status !== "completed") {
      throw conflict("Un turno completado no puede cambiar de estado");
    }
    values.status = changes.status;

    // Al confirmar una reserva → limpiar la fecha de expiración
    if (changes.status === "scheduled" && appt.status === "reserved") {
      values.reservationExpiresAt = null;
    }

    // Al completar se congela el snapshot de pago a la proveedora
    if (completando) {
      const snapshot = await computeProviderEarning(db, appt);
      Object.assign(values, snapshot);
    }


    // Al cancelar: si había una seña paga, se cancela el deal y se acredita
    // el saldo al cliente (no se pierde la plata — reglas_negocio §6.2).
    //
    // Solo se acredita si se cancela ANTES del horario del turno: avisar con
    // tiempo devuelve la seña, no presentarse la pierde. Cancelar un turno que
    // ya pasó es equivalente a un "Ausente" (que tampoco acredita), y sin este
    // corte se regalaba saldo con solo ir cancelando turnos viejos.
    //
    // Solo se RESUELVE acá; los tres writes (cancelar deal, acreditar saldo y
    // marcar el turno cancelado) se hacen abajo en una única transacción.
    if (changes.status === "cancelled" && appt.status !== "cancelled") {
      const beforeStart = !appt.appointmentStart || appt.appointmentStart > new Date();
      const deal = await getDealByAppointmentId(db, id);
      if (beforeStart && deal?.seniaPaid && deal.seniaAmount && appt.customerId) {
        dealToCancel = {
          id: deal.id,
          amount: Number(deal.seniaAmount),
          customerId: appt.customerId,
        };
      }
    }
  }

  // Al completar, el turno, el descuento de insumos y el consumo de la sesión
  // pasan JUNTOS o no pasa ninguno: si el turno quedara completado y el
  // descuento fallara, el stock mentiría para siempre y nadie se enteraría, y
  // si fallara el consumo la clienta se quedaría con una sesión que ya usó.
  // `consumo` viaja al front para avisar si algún insumo quedó en negativo —
  // no frena nada.
  //
  // El AUSENTE no escribe nada acá, y es a propósito: `estadoDeSesion()` ya lo
  // deriva como "perdida" mirando el estado del turno (reglas §3.8). Así, si
  // Laura marcó ausente por error y lo corrige, la sesión vuelve sola a estar
  // disponible; con una columna escrita habría que acordarse de deshacerla.
  if (completando) {
    return db.transaction(async (tx) => {
      const updated = await updateAppointment(tx, id, values);
      const consumo = await consumirInsumos(tx, id, appt.serviceId);
      await consumirServicioDelTurno(tx, id, new Date());
      return { ...updated, consumo };
    });
  }

  if (!dealToCancel) return updateAppointment(db, id, values);

  // Atómico: o se cancela el deal + se acredita el saldo + se cancela el turno,
  // o no pasa nada. Si esto se partiera en dos transacciones podría quedar el
  // saldo acreditado con el turno todavía activo (o al revés).
  const pending = dealToCancel;
  return db.transaction(async (tx) => {
    const cancelled = await cancelDeal(tx, pending.id, { cancelReason: "Turno cancelado" });
    if (cancelled) {
      await creditCustomer(tx, pending.customerId, pending.amount, {
        reason: "appointment_cancelled",
        appointmentId: id,
        notes: "Seña de un turno cancelado antes de su horario",
      });
    }
    return updateAppointment(tx, id, values);
  });
}

/**
 * Mueve un turno y deja constancia.
 *
 * `quien` trae el usuario del JWT y el motivo opcional que escribió quien lo
 * movió. Es opcional para no romper a nadie que llame a esto sin contexto de
 * request, pero el endpoint siempre lo manda.
 */
export async function rescheduleAppointment(
  db: Db,
  id: string,
  newStart: string,
  quien: QuienYPorQue = {},
) {
  const startDate = new Date(newStart);
  if (Number.isNaN(startDate.getTime())) throw badRequest("Fecha de inicio inválida");

  const appt = await getAppointmentById(db, id);
  if (!appt) throw notFound("Appointment");
  if (appt.status === "completed") throw conflict("Un turno completado no puede reagendarse");
  if (!appt.serviceId || !appt.serviceProviderId) throw badRequest("Turno sin servicio o proveedora");

  const localDate = utcToLocalDateString(startDate);
  // El quinto argumento saca a este mismo turno del cálculo de ocupación: si no,
  // se bloquea a sí mismo y no se lo puede correr media hora.
  const ctx = await loadAvailabilityContext(db, appt.serviceId, localDate, appt.serviceProviderId, id);
  if (!ctx.open) throw conflict("El local está cerrado ese día");
  if (ctx.providers.length === 0) throw conflict("La proveedora no está disponible ese día");

  const startMin = utcToLocalMinutes(startDate);
  const requested: Interval = { start: startMin, end: startMin + ctx.durationMinutes };
  const endDate = new Date(startDate.getTime() + ctx.durationMinutes * 60_000);

  const freeWindows = ctx.freeWindowsByProvider.get(appt.serviceProviderId) ?? [];
  const fits = freeWindows.some((w) => requested.start >= w.start && requested.end <= w.end);
  if (!fits) throw conflict("La proveedora no tiene ese horario disponible");

  return db.transaction(async (tx) => {
    const clashes = await getOverlappingAppointments(
      tx,
      { providerId: appt.serviceProviderId! },
      startDate,
      endDate,
    );
    const realClashes = clashes.filter((c) => c.id !== id);
    if (realClashes.length > 0) throw conflict("El horario acaba de ser tomado por otro turno");

    // Antes del UPDATE, porque después la fecha vieja ya no existe en ningún
    // lado. Va en la misma transacción: o se mueve y queda registrado, o no
    // pasa ninguna de las dos cosas.
    const franja = { start: startDate, end: endDate, durationMinutes: ctx.durationMinutes };
    if (huboMovimiento(appt, franja)) {
      await recordReschedule(tx, filaDeReagendado(appt, franja, quien));
    }

    return updateAppointment(tx, id, {
      appointmentStart:      startDate,
      appointmentEnd:        endDate,
      durationMinutes:       ctx.durationMinutes,
      status:                "scheduled",
      reservationExpiresAt:  null,
    });
  });
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
