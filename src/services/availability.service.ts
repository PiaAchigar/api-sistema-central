import type { Db } from "../db/client";
import { notFound } from "../lib/errors";
import {
  generateSlots,
  intersect,
  merge,
  subtractAll,
  type Interval,
} from "../lib/intervals";
import { diasDelMes } from "../lib/mes";
import {
  dayOfWeek,
  localDayRangeUtc,
  minutesToTime,
  timeToMinutes,
  todayLocal,
  utcToLocalMinutes,
} from "../lib/time";
import { anclaDeDepilacionOpcional } from "../repositories/ancla-de-depilacion.repo";
import {
  getAppointmentById,
  getBusyAppointmentsForMachines,
  getBusyAppointmentsForProviders,
} from "../repositories/appointments.repo";
import {
  getActiveAgreementsForService,
  getAgreementsForServiceInRange,
  getAllOpenHours,
  getCertifiedMachines,
  getExceptionsForDate,
  getExceptionsInRange,
  getOpenHoursForDay,
  getSaturdaySchedules,
  getSaturdaySchedulesInRange,
  getWeeklyAvailability,
  getWeeklyAvailabilityInRange,
  listActiveProviders,
} from "../repositories/providers.repo";
import { getMachinesForService, getServiceById } from "../repositories/services.repo";

export const SLOT_STEP_MINUTES = 15;

export type ProviderOption = {
  providerId: string;
  providerName: string;
  machineId: string | null;
};

export type AvailabilitySlot = {
  start: string; // HH:MM hora local ART
  end: string;
  options: ProviderOption[];
};

export type AvailabilityResult = {
  date: string;
  serviceId: string;
  durationMinutes: number;
  slots: AvailabilitySlot[];
  reason?: "closed" | "no_providers";
};

/**
 * Contexto de disponibilidad de un día: ventanas libres por proveedora
 * (ya descontados local, excepciones y turnos) y ocupación de máquinas.
 * Lo reutiliza la validación de creación de turnos.
 */
export type AvailabilityContext = {
  service: NonNullable<Awaited<ReturnType<typeof getServiceById>>>;
  durationMinutes: number;
  open: boolean;
  providers: { providerId: string; providerName: string }[];
  /** Ventanas libres por proveedora, en minutos locales. */
  freeWindowsByProvider: Map<string, Interval[]>;
  /** Máquinas candidatas por proveedora (primarias primero). */
  machinesByProvider: Map<string, string[]>;
  /** Intervalos ocupados por máquina. */
  busyByMachine: Map<string, Interval[]>;
  requiresMachine: boolean;
};

type Rango = { start: Date; end: Date };

/**
 * De dónde saca `loadAvailabilityContext` cada dato. Las firmas son las de los
 * repos de un día; así el cálculo es UNO solo y lo único que cambia es si cada
 * dato viaja a la base (`fuenteDirecta`) o sale de memoria (`fuenteDelMes`).
 */
export type FuenteDeDisponibilidad = {
  servicio: (serviceId: string) => ReturnType<typeof getServiceById>;
  horarioDelLocal: (dow: number) => ReturnType<typeof getOpenHoursForDay>;
  acuerdos: (serviceId: string, date: string) => ReturnType<typeof getActiveAgreementsForService>;
  semanal: (providerIds: string[], dow: number, date: string) => ReturnType<typeof getWeeklyAvailability>;
  sabados: (providerIds: string[], date: string) => ReturnType<typeof getSaturdaySchedules>;
  excepciones: (providerIds: string[], date: string) => ReturnType<typeof getExceptionsForDate>;
  ocupadosDeProveedoras: (providerIds: string[], r: Rango) => ReturnType<typeof getBusyAppointmentsForProviders>;
  maquinasDelServicio: (serviceId: string) => ReturnType<typeof getMachinesForService>;
  certificadas: (providerIds: string[]) => ReturnType<typeof getCertifiedMachines>;
  ocupadosDeMaquinas: (machineIds: string[], r: Rango) => ReturnType<typeof getBusyAppointmentsForMachines>;
};

export function fuenteDirecta(db: Db): FuenteDeDisponibilidad {
  return {
    servicio: (serviceId) => getServiceById(db, serviceId),
    horarioDelLocal: (dow) => getOpenHoursForDay(db, dow),
    acuerdos: (serviceId, date) => getActiveAgreementsForService(db, serviceId, date),
    semanal: (ids, dow, date) => getWeeklyAvailability(db, ids, dow, date),
    sabados: (ids, date) => getSaturdaySchedules(db, ids, date),
    excepciones: (ids, date) => getExceptionsForDate(db, ids, date),
    ocupadosDeProveedoras: (ids, r) => getBusyAppointmentsForProviders(db, ids, r),
    maquinasDelServicio: (serviceId) => getMachinesForService(db, serviceId),
    certificadas: (ids) => getCertifiedMachines(db, ids),
    ocupadosDeMaquinas: (ids, r) => getBusyAppointmentsForMachines(db, ids, r),
  };
}

const vigenteEl = (d: string, desde: string | null, hasta: string | null) =>
  (desde == null || desde <= d) && (hasta == null || hasta >= d);
const empiezaEn = (a: { appointmentStart: Date | null }, r: Rango) =>
  a.appointmentStart != null && a.appointmentStart >= r.start && a.appointmentStart < r.end;

/**
 * Todo lo que necesita la disponibilidad de UN servicio en [from, to], traído
 * con una consulta por tabla. Después cada día se arma en memoria aplicando las
 * mismas condiciones que las consultas de un día (vigencias, fecha exacta o
 * rango de la excepción, turnos que EMPIEZAN dentro del día).
 *
 * Existe porque contra producción cada consulta cuesta cientos de ms: el
 * calendario de un mes hacía ~9 por día (~235) y tardaba ~20 s.
 */
export async function fuenteDelMes(
  db: Db,
  serviceId: string,
  from: string,
  to: string,
  providerIdFilter?: string,
): Promise<FuenteDeDisponibilidad> {
  const rango: Rango = { start: localDayRangeUtc(from).start, end: localDayRangeUtc(to).end };
  const [svc, horarios, todosLosAcuerdos, maquinasDelServicio] = await Promise.all([
    getServiceById(db, serviceId),
    getAllOpenHours(db),
    getAgreementsForServiceInRange(db, serviceId, from, to),
    getMachinesForService(db, serviceId),
  ]);
  const acuerdos = providerIdFilter
    ? todosLosAcuerdos.filter((a) => a.providerId === providerIdFilter)
    : todosLosAcuerdos;
  const providerIds = [...new Set(acuerdos.map((a) => a.providerId))];
  const machineIds = maquinasDelServicio.map((m) => m.machineId);
  const requiresMachine = svc?.requiresMachine === true;
  const [semanal, sabados, excepciones, ocupados, certificadas, ocupadosMaq] = await Promise.all([
    getWeeklyAvailabilityInRange(db, providerIds, from, to),
    getSaturdaySchedulesInRange(db, providerIds, from, to),
    getExceptionsInRange(db, providerIds, from, to),
    getBusyAppointmentsForProviders(db, providerIds, rango),
    requiresMachine ? getCertifiedMachines(db, providerIds) : Promise.resolve([]),
    requiresMachine ? getBusyAppointmentsForMachines(db, machineIds, rango) : Promise.resolve([]),
  ]);

  const deEstas = (ids: string[]) => {
    const set = new Set(ids);
    return <T extends { providerId: string | null }>(x: T) => x.providerId != null && set.has(x.providerId);
  };

  return {
    servicio: async () => svc,
    horarioDelLocal: async (dow) => {
      const h = horarios.find((x) => x.dayOfWeek === dow);
      return h ? { openingTime: h.openingTime, closingTime: h.closingTime, isOpen: h.isOpen } : null;
    },
    acuerdos: async (_serviceId, date) =>
      todosLosAcuerdos
        .filter((a) => vigenteEl(date, a.validFrom, a.validUntil))
        .map(({ providerId, providerName, paymentType, rate }) => ({ providerId, providerName, paymentType, rate })),
    semanal: async (ids, dow, date) =>
      semanal
        .filter(deEstas(ids))
        .filter((w) => w.dayOfWeek === dow && vigenteEl(date, w.validFrom, w.validUntil))
        .map(({ providerId, workStartTime, workEndTime }) => ({ providerId, workStartTime, workEndTime })),
    sabados: async (ids, date) =>
      sabados
        .filter(deEstas(ids))
        .filter((x) => x.saturdayDate === date)
        .map(({ providerId, isWorking, workStartTime, workEndTime }) => ({ providerId, isWorking, workStartTime, workEndTime })),
    excepciones: async (ids, date) =>
      excepciones
        .filter(deEstas(ids))
        .filter(
          (e) =>
            e.dateException === date ||
            (e.dateStart != null && e.dateEnd != null && e.dateStart <= date && e.dateEnd >= date),
        )
        .map(({ providerId, isWorking, timeOverrideStart, timeOverrideEnd, exceptionType }) => ({
          providerId, isWorking, timeOverrideStart, timeOverrideEnd, exceptionType,
        })),
    ocupadosDeProveedoras: async (ids, r) => ocupados.filter(deEstas(ids)).filter((a) => empiezaEn(a, r)),
    maquinasDelServicio: async () => maquinasDelServicio,
    certificadas: async (ids) => certificadas.filter(deEstas(ids)),
    ocupadosDeMaquinas: async (ids, r) => {
      const set = new Set(ids);
      return ocupadosMaq.filter((a) => a.machineId != null && set.has(a.machineId) && empiezaEn(a, r));
    },
  };
}

/**
 * `excludeAppointmentId` saca un turno del cálculo de ocupación.
 *
 * Es lo que hace posible reagendar un turno DENTRO de su propia franja: sin
 * esto, un turno de 9:30 a 10:30 se bloquea a sí mismo y moverlo a las 10:00
 * fallaba con "La proveedora no tiene ese horario disponible" — un mensaje que
 * además miente, porque la proveedora está libre. Sólo lo usa el reagendado; al
 * crear un turno y al listar slots no hay ningún turno propio que ignorar.
 */
export async function loadAvailabilityContext(
  db: Db,
  serviceId: string,
  date: string,
  providerIdFilter?: string,
  excludeAppointmentId?: string,
  fuente: FuenteDeDisponibilidad = fuenteDirecta(db),
): Promise<AvailabilityContext> {
  const svc = await fuente.servicio(serviceId);
  if (!svc) throw notFound("Service");
  const durationMinutes = svc.estimatedDurationMinutes ?? 30;

  const dow = dayOfWeek(date);
  const openRow = await fuente.horarioDelLocal(dow);
  const empty: AvailabilityContext = {
    service: svc,
    durationMinutes,
    open: false,
    providers: [],
    freeWindowsByProvider: new Map(),
    machinesByProvider: new Map(),
    busyByMachine: new Map(),
    requiresMachine: svc.requiresMachine === true,
  };
  if (!openRow || openRow.isOpen === false || !openRow.openingTime || !openRow.closingTime) {
    return empty;
  }
  const localWindow: Interval = {
    start: timeToMinutes(openRow.openingTime),
    end: timeToMinutes(openRow.closingTime),
  };

  let agreements = await fuente.acuerdos(serviceId, date);
  if (providerIdFilter) {
    agreements = agreements.filter((a) => a.providerId === providerIdFilter);
  }
  const providers = [
    ...new Map(
      agreements.map((a) => [a.providerId, { providerId: a.providerId, providerName: a.providerName ?? "" }]),
    ).values(),
  ];
  const providerIds = providers.map((p) => p.providerId);

  // Ventanas base: sábado usa la tabla de sábados específicos; el resto, el horario semanal
  const baseWindows = new Map<string, Interval[]>();
  if (dow === 6) {
    const saturdays = await fuente.sabados(providerIds, date);
    for (const s of saturdays) {
      if (s.isWorking && s.workStartTime && s.workEndTime && s.providerId) {
        baseWindows.set(s.providerId, [
          { start: timeToMinutes(s.workStartTime), end: timeToMinutes(s.workEndTime) },
        ]);
      }
    }
  } else {
    const weekly = await fuente.semanal(providerIds, dow, date);
    for (const w of weekly) {
      if (!w.providerId || !w.workStartTime || !w.workEndTime) continue;
      const list = baseWindows.get(w.providerId) ?? [];
      list.push({ start: timeToMinutes(w.workStartTime), end: timeToMinutes(w.workEndTime) });
      baseWindows.set(w.providerId, list);
    }
  }

  // Excepciones: bloqueo total, bloqueo parcial u override de horario
  const exceptions = await fuente.excepciones(providerIds, date);
  for (const ex of exceptions) {
    if (!ex.providerId) continue;
    const current = baseWindows.get(ex.providerId) ?? [];
    const hasOverride = ex.timeOverrideStart && ex.timeOverrideEnd;
    if (ex.isWorking === false) {
      if (hasOverride) {
        baseWindows.set(
          ex.providerId,
          subtractAll(current, [
            {
              start: timeToMinutes(ex.timeOverrideStart!),
              end: timeToMinutes(ex.timeOverrideEnd!),
            },
          ]),
        );
      } else {
        baseWindows.set(ex.providerId, []);
      }
    } else if (hasOverride) {
      baseWindows.set(ex.providerId, [
        {
          start: timeToMinutes(ex.timeOverrideStart!),
          end: timeToMinutes(ex.timeOverrideEnd!),
        },
      ]);
    }
  }

  // Intersección con el horario del local + restar turnos existentes
  const dayRange = localDayRangeUtc(date);
  const busyAppointments = await fuente.ocupadosDeProveedoras(providerIds, dayRange);
  const busyByProvider = new Map<string, Interval[]>();
  for (const appt of busyAppointments) {
    if (appt.id === excludeAppointmentId) continue;
    if (!appt.providerId || !appt.appointmentStart || !appt.appointmentEnd) continue;
    const list = busyByProvider.get(appt.providerId) ?? [];
    list.push({
      start: utcToLocalMinutes(appt.appointmentStart),
      end: utcToLocalMinutes(appt.appointmentEnd),
    });
    busyByProvider.set(appt.providerId, list);
  }

  const freeWindowsByProvider = new Map<string, Interval[]>();
  for (const pid of providerIds) {
    const windows = intersect(merge(baseWindows.get(pid) ?? []), localWindow);
    freeWindowsByProvider.set(pid, subtractAll(windows, busyByProvider.get(pid) ?? []));
  }

  // Máquinas: candidatas del servicio ∩ certificación de cada proveedora
  const machinesByProvider = new Map<string, string[]>();
  const busyByMachine = new Map<string, Interval[]>();
  if (svc.requiresMachine) {
    const svcMachines = await fuente.maquinasDelServicio(serviceId);
    // primarias primero
    const orderedMachineIds = [...svcMachines]
      .sort((a, b) => Number(b.isPrimaryMachine ?? false) - Number(a.isPrimaryMachine ?? false))
      .map((m) => m.machineId);
    const certified = await fuente.certificadas(providerIds);
    const certifiedSet = new Set(certified.map((c) => `${c.providerId}|${c.machineId}`));
    for (const pid of providerIds) {
      machinesByProvider.set(
        pid,
        orderedMachineIds.filter((mid) => certifiedSet.has(`${pid}|${mid}`)),
      );
    }
    const machineBusy = await fuente.ocupadosDeMaquinas(orderedMachineIds, dayRange);
    for (const appt of machineBusy) {
      if (appt.id === excludeAppointmentId) continue;
      if (!appt.machineId || !appt.appointmentStart || !appt.appointmentEnd) continue;
      const list = busyByMachine.get(appt.machineId) ?? [];
      list.push({
        start: utcToLocalMinutes(appt.appointmentStart),
        end: utcToLocalMinutes(appt.appointmentEnd),
      });
      busyByMachine.set(appt.machineId, list);
    }
  }

  return {
    service: svc,
    durationMinutes,
    open: true,
    providers,
    freeWindowsByProvider,
    machinesByProvider,
    busyByMachine,
    requiresMachine: svc.requiresMachine === true,
  };
}

export type ProviderDaySchedule = {
  providerId: string;
  windows: Interval[]; // en minutos locales ART; vacío = no trabaja ese día
};

/**
 * Horario de trabajo de cada proveedora activa para un día dado.
 * Considera: horario semanal, sábados específicos, excepciones y horario del local.
 * No filtra por servicio — sirve para pintar el fondo del grid de la agenda.
 */
export async function getProviderSchedules(db: Db, date: string): Promise<ProviderDaySchedule[]> {
  const dow = dayOfWeek(date);
  const openRow = await getOpenHoursForDay(db, dow);
  if (!openRow || openRow.isOpen === false || !openRow.openingTime || !openRow.closingTime) {
    return [];
  }
  const localWindow: Interval = {
    start: timeToMinutes(openRow.openingTime),
    end:   timeToMinutes(openRow.closingTime),
  };

  const providers = await listActiveProviders(db);
  const providerIds = providers.map((p) => p.id);

  const baseWindows = new Map<string, Interval[]>();
  if (dow === 6) {
    const saturdays = await getSaturdaySchedules(db, providerIds, date);
    for (const s of saturdays) {
      if (s.isWorking && s.workStartTime && s.workEndTime && s.providerId) {
        baseWindows.set(s.providerId, [
          { start: timeToMinutes(s.workStartTime), end: timeToMinutes(s.workEndTime) },
        ]);
      }
    }
  } else {
    const weekly = await getWeeklyAvailability(db, providerIds, dow, date);
    for (const w of weekly) {
      if (!w.providerId || !w.workStartTime || !w.workEndTime) continue;
      const list = baseWindows.get(w.providerId) ?? [];
      list.push({ start: timeToMinutes(w.workStartTime), end: timeToMinutes(w.workEndTime) });
      baseWindows.set(w.providerId, list);
    }
  }

  const exceptions = await getExceptionsForDate(db, providerIds, date);
  for (const ex of exceptions) {
    if (!ex.providerId) continue;
    const current = baseWindows.get(ex.providerId) ?? [];
    const hasOverride = ex.timeOverrideStart && ex.timeOverrideEnd;
    if (ex.isWorking === false) {
      baseWindows.set(
        ex.providerId,
        hasOverride
          ? subtractAll(current, [{
              start: timeToMinutes(ex.timeOverrideStart!),
              end:   timeToMinutes(ex.timeOverrideEnd!),
            }])
          : [],
      );
    } else if (hasOverride) {
      baseWindows.set(ex.providerId, [
        { start: timeToMinutes(ex.timeOverrideStart!), end: timeToMinutes(ex.timeOverrideEnd!) },
      ]);
    }
  }

  return providers.map((p) => ({
    providerId: p.id,
    windows:    intersect(merge(baseWindows.get(p.id) ?? []), localWindow),
  }));
}

export async function getAvailability(
  db: Db,
  serviceId: string,
  date: string,
  providerIdFilter?: string,
  excludeAppointmentId?: string,
  duracionDelTurno?: number | null,
  fuente?: FuenteDeDisponibilidad,
): Promise<AvailabilityResult> {
  const ctx = await loadAvailabilityContext(db, serviceId, date, providerIdFilter, excludeAppointmentId, fuente);
  const duracion =
    duracionDelTurno !== undefined
      ? (duracionDelTurno ?? ctx.durationMinutes)
      : ((await duracionAlReagendar(db, serviceId, excludeAppointmentId)) ?? ctx.durationMinutes);
  const base: AvailabilityResult = {
    date,
    serviceId,
    durationMinutes: duracion,
    slots: [],
  };
  if (!ctx.open) return { ...base, reason: "closed" };
  if (ctx.providers.length === 0) return { ...base, reason: "no_providers" };

  // Slots de hoy: descartar horarios ya pasados
  const minStart = date === todayLocal() ? utcToLocalMinutes(new Date()) : -1;

  const optionsByStart = new Map<number, ProviderOption[]>();
  for (const provider of ctx.providers) {
    const windows = ctx.freeWindowsByProvider.get(provider.providerId) ?? [];
    if (!ctx.requiresMachine) {
      for (const start of generateSlots(windows, duracion, SLOT_STEP_MINUTES)) {
        if (start <= minStart) continue;
        const list = optionsByStart.get(start) ?? [];
        list.push({ ...provider, machineId: null });
        optionsByStart.set(start, list);
      }
      continue;
    }
    // Con máquina: por cada inicio, la primera máquina certificada libre (primaria primero)
    const seenStarts = new Set<number>();
    for (const machineId of ctx.machinesByProvider.get(provider.providerId) ?? []) {
      const machineFree = subtractAll(windows, ctx.busyByMachine.get(machineId) ?? []);
      for (const start of generateSlots(machineFree, duracion, SLOT_STEP_MINUTES)) {
        if (start <= minStart || seenStarts.has(start)) continue;
        seenStarts.add(start);
        const list = optionsByStart.get(start) ?? [];
        list.push({ ...provider, machineId });
        optionsByStart.set(start, list);
      }
    }
  }

  const slots: AvailabilitySlot[] = [...optionsByStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, options]) => ({
      start: minutesToTime(start),
      end: minutesToTime(start + duracion),
      options,
    }));

  return { ...base, slots };
}

/**
 * Qué días de un mes tienen al menos un hueco libre para UNA proveedora y un
 * servicio — lo que pinta de verde el calendario de "Reagendar".
 *
 * Un día cuenta cuando `getAvailability` devuelve algún slot: es EXACTAMENTE lo
 * que Laura va a ver en el select de hora al clickearlo, así que el calendario
 * nunca pinta de verde un día en el que después no hay horarios (máquina
 * ocupada, hora de hoy ya pasada, etc.). Los días anteriores a hoy ni se
 * consultan. `excludeAppointmentId` es el turno que se está moviendo: su propio
 * hueco cuenta como libre.
 */
export async function getMonthAvailability(
  db: Db,
  serviceId: string,
  providerId: string,
  month: string,
  excludeAppointmentId?: string,
): Promise<{ month: string; availableDays: string[] }> {
  const hoy = todayLocal();
  const candidatos = diasDelMes(month).filter((d) => d >= hoy);
  if (candidatos.length === 0) return { month, availableDays: [] };
  // Todo se trae UNA vez para el mes (ver `fuenteDelMes`); cada día se arma
  // después en memoria con el mismo cálculo que el endpoint de un día.
  const [duracion, fuente] = await Promise.all([
    duracionAlReagendar(db, serviceId, excludeAppointmentId),
    fuenteDelMes(db, serviceId, candidatos[0]!, candidatos.at(-1)!, providerId),
  ]);
  const resultados = await Promise.all(
    candidatos.map((d) =>
      getAvailability(db, serviceId, d, providerId, excludeAppointmentId, duracion, fuente),
    ),
  );
  return {
    month,
    availableDays: candidatos.filter((_, i) => resultados[i]!.slots.length > 0),
  };
}

/**
 * La duración con la que hay que buscar huecos para MOVER un turno, o `null`
 * si es la del catálogo.
 *
 * Sólo cambia en depilación: el ancla tiene una duración de relleno (30, 1.56.0)
 * y la real es la que el turno guardó al crearse (la suma de sus zonas) — la
 * misma que usa `rescheduleAppointment` para validar. Sin esto el calendario y
 * el select de hora ofrecen horarios que después el reagendado rechaza.
 */
async function duracionAlReagendar(
  db: Db,
  serviceId: string,
  excludeAppointmentId?: string,
): Promise<number | null> {
  if (!excludeAppointmentId) return null;
  const ancla = await anclaDeDepilacionOpcional(db);
  if (ancla == null || ancla !== serviceId) return null;
  const turno = await getAppointmentById(db, excludeAppointmentId);
  return turno?.serviceId === serviceId ? (turno.durationMinutes ?? null) : null;
}
