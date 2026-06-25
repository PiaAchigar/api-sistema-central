import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  openHours,
  providerAvailabilityExceptions,
  providerSaturdaySchedule,
  serviceProviderAvailability,
  serviceProviderMachine,
  serviceProviders,
  serviceProviderService,
} from "../db/schema";

export async function listActiveProviders(db: Db, serviceId?: string) {
  if (serviceId) {
    return db
      .select({
        id: serviceProviders.id,
        fullName: serviceProviders.fullName,
        specialties: serviceProviders.specialties,
      })
      .from(serviceProviders)
      .innerJoin(
        serviceProviderService,
        eq(serviceProviderService.serviceProviderId, serviceProviders.id),
      )
      .where(
        and(
          eq(serviceProviders.status, "active"),
          eq(serviceProviderService.serviceId, serviceId),
          eq(serviceProviderService.isActive, true),
        ),
      )
      .orderBy(asc(serviceProviders.fullName));
  }
  return db
    .select({
      id: serviceProviders.id,
      fullName: serviceProviders.fullName,
      specialties: serviceProviders.specialties,
    })
    .from(serviceProviders)
    .where(eq(serviceProviders.status, "active"))
    .orderBy(asc(serviceProviders.fullName));
}

export async function getProviderById(db: Db, id: string) {
  const rows = await db
    .select({
      id: serviceProviders.id,
      fullName: serviceProviders.fullName,
      status: serviceProviders.status,
    })
    .from(serviceProviders)
    .where(eq(serviceProviders.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Acuerdos activos y vigentes a la fecha para un servicio, con la proveedora activa. */
export async function getActiveAgreementsForService(
  db: Db,
  serviceId: string,
  date: string,
) {
  return db
    .select({
      providerId: serviceProviders.id,
      providerName: serviceProviders.fullName,
      paymentType: serviceProviderService.paymentType,
      rate: serviceProviderService.rate,
    })
    .from(serviceProviderService)
    .innerJoin(
      serviceProviders,
      eq(serviceProviders.id, serviceProviderService.serviceProviderId),
    )
    .where(
      and(
        eq(serviceProviderService.serviceId, serviceId),
        eq(serviceProviderService.isActive, true),
        eq(serviceProviders.status, "active"),
        or(isNull(serviceProviderService.validFrom), lte(serviceProviderService.validFrom, date)),
        or(isNull(serviceProviderService.validUntil), gte(serviceProviderService.validUntil, date)),
      ),
    );
}

export async function getActiveAgreement(db: Db, providerId: string, serviceId: string) {
  const rows = await db
    .select({
      paymentType: serviceProviderService.paymentType,
      rate: serviceProviderService.rate,
    })
    .from(serviceProviderService)
    .where(
      and(
        eq(serviceProviderService.serviceProviderId, providerId),
        eq(serviceProviderService.serviceId, serviceId),
        eq(serviceProviderService.isActive, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Horarios base recurrentes vigentes a la fecha para varias proveedoras. */
export async function getWeeklyAvailability(
  db: Db,
  providerIds: string[],
  dayOfWeekNum: number,
  date: string,
) {
  if (providerIds.length === 0) return [];
  return db
    .select({
      providerId: serviceProviderAvailability.serviceProviderId,
      workStartTime: serviceProviderAvailability.workStartTime,
      workEndTime: serviceProviderAvailability.workEndTime,
    })
    .from(serviceProviderAvailability)
    .where(
      and(
        inArray(serviceProviderAvailability.serviceProviderId, providerIds),
        eq(serviceProviderAvailability.dayOfWeek, dayOfWeekNum),
        eq(serviceProviderAvailability.isActive, true),
        or(
          isNull(serviceProviderAvailability.validFrom),
          lte(serviceProviderAvailability.validFrom, date),
        ),
        or(
          isNull(serviceProviderAvailability.validUntil),
          gte(serviceProviderAvailability.validUntil, date),
        ),
      ),
    );
}

/** Sábados específicos por fecha exacta. */
export async function getSaturdaySchedules(db: Db, providerIds: string[], date: string) {
  if (providerIds.length === 0) return [];
  return db
    .select({
      providerId: providerSaturdaySchedule.serviceProviderId,
      isWorking: providerSaturdaySchedule.isWorking,
      workStartTime: providerSaturdaySchedule.workStartTime,
      workEndTime: providerSaturdaySchedule.workEndTime,
    })
    .from(providerSaturdaySchedule)
    .where(
      and(
        inArray(providerSaturdaySchedule.serviceProviderId, providerIds),
        eq(providerSaturdaySchedule.saturdayDate, date),
      ),
    );
}

/** Excepciones que afectan la fecha (día exacto o rango). */
export async function getExceptionsForDate(db: Db, providerIds: string[], date: string) {
  if (providerIds.length === 0) return [];
  return db
    .select({
      providerId: providerAvailabilityExceptions.serviceProviderId,
      isWorking: providerAvailabilityExceptions.isWorking,
      timeOverrideStart: providerAvailabilityExceptions.timeOverrideStart,
      timeOverrideEnd: providerAvailabilityExceptions.timeOverrideEnd,
      exceptionType: providerAvailabilityExceptions.exceptionType,
    })
    .from(providerAvailabilityExceptions)
    .where(
      and(
        inArray(providerAvailabilityExceptions.serviceProviderId, providerIds),
        or(
          eq(providerAvailabilityExceptions.dateException, date),
          and(
            lte(providerAvailabilityExceptions.dateStart, date),
            gte(providerAvailabilityExceptions.dateEnd, date),
          ),
        ),
      ),
    );
}

/** Máquinas en las que cada proveedora está certificada. */
export async function getCertifiedMachines(db: Db, providerIds: string[]) {
  if (providerIds.length === 0) return [];
  return db
    .select({
      providerId: serviceProviderMachine.serviceProviderId,
      machineId: serviceProviderMachine.machineId,
    })
    .from(serviceProviderMachine)
    .where(inArray(serviceProviderMachine.serviceProviderId, providerIds));
}

export async function getOpenHoursForDay(db: Db, dayOfWeekNum: number) {
  const rows = await db
    .select({
      openingTime: openHours.openingTime,
      closingTime: openHours.closingTime,
      isOpen: openHours.isOpen,
    })
    .from(openHours)
    .where(eq(openHours.dayOfWeek, dayOfWeekNum))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAllOpenHours(db: Db) {
  return db
    .select({
      dayOfWeek: openHours.dayOfWeek,
      openingTime: openHours.openingTime,
      closingTime: openHours.closingTime,
      isOpen: openHours.isOpen,
    })
    .from(openHours)
    .orderBy(asc(openHours.dayOfWeek));
}

// ── CRUD admin de proveedoras ───────────────────────────────────────────────

const providerFields = {
  id: serviceProviders.id,
  fullName: serviceProviders.fullName,
  email: serviceProviders.email,
  phone: serviceProviders.phone,
  dni: serviceProviders.dni,
  cuit: serviceProviders.cuit,
  specialties: serviceProviders.specialties,
  notes: serviceProviders.notes,
  address: serviceProviders.address,
  postalCode: serviceProviders.postalCode,
  status: serviceProviders.status,
};

/** Lista completa para la vista admin (incluye archivadas si `includeInactive`). */
export async function listProvidersAdmin(db: Db, includeInactive = false) {
  const base = db.select(providerFields).from(serviceProviders);
  const ordered = includeInactive
    ? base
    : base.where(eq(serviceProviders.status, "active"));
  return ordered.orderBy(asc(serviceProviders.fullName));
}

type ProviderWritable = {
  fullName?: string;
  email?: string | null;
  phone?: string | null;
  dni?: string | null;
  cuit?: string | null;
  specialties?: string | null;
  notes?: string | null;
  address?: string | null;
  postalCode?: string | null;
};

function toProviderSet(p: ProviderWritable) {
  return {
    ...(p.fullName !== undefined && { fullName: p.fullName }),
    ...(p.email !== undefined && { email: p.email }),
    ...(p.phone !== undefined && { phone: p.phone }),
    ...(p.dni !== undefined && { dni: p.dni }),
    ...(p.cuit !== undefined && { cuit: p.cuit }),
    ...(p.specialties !== undefined && { specialties: p.specialties }),
    ...(p.notes !== undefined && { notes: p.notes }),
    ...(p.address !== undefined && { address: p.address }),
    ...(p.postalCode !== undefined && { postalCode: p.postalCode }),
  };
}

export async function createProvider(db: Db, data: ProviderWritable & { fullName: string }) {
  const rows = await db
    .insert(serviceProviders)
    .values({ ...toProviderSet(data), status: "active" })
    .returning(providerFields);
  return rows[0]!;
}

export async function updateProvider(db: Db, id: string, patch: ProviderWritable) {
  const rows = await db
    .update(serviceProviders)
    .set(toProviderSet(patch))
    .where(eq(serviceProviders.id, id))
    .returning(providerFields);
  return rows[0] ?? null;
}

/** Soft-delete / restore: cambia `status` (active ↔ inactive), nunca borra (regla 1.3). */
export async function setProviderStatus(db: Db, id: string, status: "active" | "inactive") {
  const rows = await db
    .update(serviceProviders)
    .set({ status })
    .where(eq(serviceProviders.id, id))
    .returning(providerFields);
  return rows[0] ?? null;
}
