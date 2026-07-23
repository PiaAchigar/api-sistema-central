import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { type AgreementInput, diffAgreements } from "../lib/agreements";
import {
  appointments,
  mercadopagoAccounts,
  openHours,
  payments,
  promotionService,
  providerAvailabilityAudit,
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

// ── Acuerdos proveedora↔servicio (service_provider_service) ──────────────────

/** Filas de acuerdo VIGENTES (is_active=true) de un servicio, para editar/reconciliar.
 *  Incluye el nombre de la proveedora para prefill del modal. */
export async function listAgreementRowsForService(db: Db, serviceId: string) {
  const rows = await db
    .select({
      serviceProviderId: serviceProviderService.serviceProviderId,
      providerName: serviceProviders.fullName,
      paymentType: serviceProviderService.paymentType,
      rate: serviceProviderService.rate,
    })
    .from(serviceProviderService)
    .innerJoin(serviceProviders, eq(serviceProviders.id, serviceProviderService.serviceProviderId))
    .where(
      and(
        eq(serviceProviderService.serviceId, serviceId),
        eq(serviceProviderService.isActive, true),
      ),
    );
  return rows.map((r) => ({
    serviceProviderId: r.serviceProviderId as string,
    providerName: r.providerName,
    paymentType: r.paymentType,
    rate: r.rate != null ? Number(r.rate) : null,
  }));
}

/** Reconcilia los acuerdos de un servicio respetando §4 (cerrar viejo + crear nuevo).
 *  `today` en formato YYYY-MM-DD (lo provee la ruta con todayLocal()). */
export async function setServiceAgreements(
  db: Db,
  serviceId: string,
  desired: AgreementInput[],
  today: string,
) {
  const current = await listAgreementRowsForService(db, serviceId);
  const { toCreate, toCloseProviderIds } = diffAgreements(
    current.map((c) => ({
      serviceProviderId: c.serviceProviderId,
      paymentType: c.paymentType,
      rate: c.rate,
    })),
    desired,
  );

  for (const providerId of toCloseProviderIds) {
    await db
      .update(serviceProviderService)
      .set({ isActive: false, validUntil: today })
      .where(
        and(
          eq(serviceProviderService.serviceId, serviceId),
          eq(serviceProviderService.serviceProviderId, providerId),
          eq(serviceProviderService.isActive, true),
        ),
      );
  }

  if (toCreate.length > 0) {
    await db.insert(serviceProviderService).values(
      toCreate.map((a) => ({
        serviceProviderId: a.serviceProviderId,
        serviceId,
        paymentType: a.paymentType,
        rate: a.rate != null ? String(a.rate) : null,
        validFrom: today,
        isActive: true,
      })),
    );
  }
}

// ── Hard-delete (borrado permanente, admin-only) ────────────────────────────

/** Cuenta referencias de la proveedora en tablas fiscales/operativas. Si hay
 *  turnos o pagos recibidos directamente, el hard-delete se bloquea (mismo
 *  criterio que Servicio — ver reglas_negocio §1.3/§5.1). El resto (acuerdos,
 *  máquinas certificadas, disponibilidad, cuentas MP, promo-service) son datos
 *  de configuración que sí se borran en cascada. */
export async function getProviderDeleteImpact(db: Db, id: string) {
  const [appts, pays, agreements, mach, avail, saturdays, exceptions, mp, promos] =
    await Promise.all([
      db.select({ id: appointments.id }).from(appointments).where(eq(appointments.serviceProviderId, id)),
      db.select({ id: payments.id }).from(payments).where(eq(payments.receivedByProviderId, id)),
      db
        .select({ id: serviceProviderService.id })
        .from(serviceProviderService)
        .where(eq(serviceProviderService.serviceProviderId, id)),
      db
        .select({ id: serviceProviderMachine.id })
        .from(serviceProviderMachine)
        .where(eq(serviceProviderMachine.serviceProviderId, id)),
      db
        .select({ id: serviceProviderAvailability.id })
        .from(serviceProviderAvailability)
        .where(eq(serviceProviderAvailability.serviceProviderId, id)),
      db
        .select({ id: providerSaturdaySchedule.id })
        .from(providerSaturdaySchedule)
        .where(eq(providerSaturdaySchedule.serviceProviderId, id)),
      db
        .select({ id: providerAvailabilityExceptions.id })
        .from(providerAvailabilityExceptions)
        .where(eq(providerAvailabilityExceptions.serviceProviderId, id)),
      db
        .select({ id: mercadopagoAccounts.id })
        .from(mercadopagoAccounts)
        .where(eq(mercadopagoAccounts.serviceProviderId, id)),
      db
        .select({ id: promotionService.id })
        .from(promotionService)
        .where(eq(promotionService.serviceProviderId, id)),
    ]);

  const parts: string[] = [];
  if (appts.length > 0) parts.push(`${appts.length} turno(s)`);
  if (pays.length > 0) parts.push(`${pays.length} pago(s) recibido(s)`);

  return {
    blocked: parts.length > 0,
    blockReason:
      parts.length > 0
        ? `Tiene ${parts.join(" y ")} asociado(s). Archivalo en su lugar.`
        : undefined,
    cascade: {
      agreements: agreements.length,
      machines: mach.length,
      weeklyAvailability: avail.length,
      saturdaySchedule: saturdays.length,
      exceptions: exceptions.length,
      mpAccounts: mp.length,
      promotions: promos.length,
    },
  };
}

/** Borra la proveedora y su configuración asociada en una sola transacción.
 *  El caller (ruta) debe haber verificado que `getProviderDeleteImpact` no esté
 *  `blocked` antes de llamar esta función. Incluye `provider_availability_audit`
 *  porque tiene una FK real a `service_providers` (init.sql fk_provaudit_provider)
 *  aunque sea solo un log — si no se borra, el DELETE final falla por FK. */
export async function hardDeleteProvider(db: Db, id: string): Promise<boolean> {
  const deleted = await db.transaction(async (tx) => {
    await tx.delete(serviceProviderService).where(eq(serviceProviderService.serviceProviderId, id));
    await tx.delete(serviceProviderMachine).where(eq(serviceProviderMachine.serviceProviderId, id));
    await tx
      .delete(serviceProviderAvailability)
      .where(eq(serviceProviderAvailability.serviceProviderId, id));
    await tx.delete(providerSaturdaySchedule).where(eq(providerSaturdaySchedule.serviceProviderId, id));
    await tx
      .delete(providerAvailabilityExceptions)
      .where(eq(providerAvailabilityExceptions.serviceProviderId, id));
    await tx.delete(providerAvailabilityAudit).where(eq(providerAvailabilityAudit.serviceProviderId, id));
    await tx.delete(mercadopagoAccounts).where(eq(mercadopagoAccounts.serviceProviderId, id));
    await tx.delete(promotionService).where(eq(promotionService.serviceProviderId, id));
    return tx.delete(serviceProviders).where(eq(serviceProviders.id, id)).returning({ id: serviceProviders.id });
  });
  return deleted.length > 0;
}
