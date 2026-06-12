import type { Db } from "../db/client";
import { notFound } from "../lib/errors";
import {
  generateSlots,
  intersect,
  merge,
  subtractAll,
  type Interval,
} from "../lib/intervals";
import {
  dayOfWeek,
  localDayRangeUtc,
  minutesToTime,
  timeToMinutes,
  todayLocal,
  utcToLocalMinutes,
} from "../lib/time";
import {
  getBusyAppointmentsForMachines,
  getBusyAppointmentsForProviders,
} from "../repositories/appointments.repo";
import {
  getActiveAgreementsForService,
  getCertifiedMachines,
  getExceptionsForDate,
  getOpenHoursForDay,
  getSaturdaySchedules,
  getWeeklyAvailability,
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

export async function loadAvailabilityContext(
  db: Db,
  serviceId: string,
  date: string,
  providerIdFilter?: string,
): Promise<AvailabilityContext> {
  const svc = await getServiceById(db, serviceId);
  if (!svc) throw notFound("Service");
  const durationMinutes = svc.estimatedDurationMinutes ?? 30;

  const dow = dayOfWeek(date);
  const openRow = await getOpenHoursForDay(db, dow);
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

  let agreements = await getActiveAgreementsForService(db, serviceId, date);
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

  // Excepciones: bloqueo total, bloqueo parcial u override de horario
  const exceptions = await getExceptionsForDate(db, providerIds, date);
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
  const busyAppointments = await getBusyAppointmentsForProviders(db, providerIds, dayRange);
  const busyByProvider = new Map<string, Interval[]>();
  for (const appt of busyAppointments) {
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
    const svcMachines = await getMachinesForService(db, serviceId);
    // primarias primero
    const orderedMachineIds = [...svcMachines]
      .sort((a, b) => Number(b.isPrimaryMachine ?? false) - Number(a.isPrimaryMachine ?? false))
      .map((m) => m.machineId);
    const certified = await getCertifiedMachines(db, providerIds);
    const certifiedSet = new Set(certified.map((c) => `${c.providerId}|${c.machineId}`));
    for (const pid of providerIds) {
      machinesByProvider.set(
        pid,
        orderedMachineIds.filter((mid) => certifiedSet.has(`${pid}|${mid}`)),
      );
    }
    const machineBusy = await getBusyAppointmentsForMachines(db, orderedMachineIds, dayRange);
    for (const appt of machineBusy) {
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

export async function getAvailability(
  db: Db,
  serviceId: string,
  date: string,
  providerIdFilter?: string,
): Promise<AvailabilityResult> {
  const ctx = await loadAvailabilityContext(db, serviceId, date, providerIdFilter);
  const base: AvailabilityResult = {
    date,
    serviceId,
    durationMinutes: ctx.durationMinutes,
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
      for (const start of generateSlots(windows, ctx.durationMinutes, SLOT_STEP_MINUTES)) {
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
      for (const start of generateSlots(machineFree, ctx.durationMinutes, SLOT_STEP_MINUTES)) {
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
      end: minutesToTime(start + ctx.durationMinutes),
      options,
    }));

  return { ...base, slots };
}
