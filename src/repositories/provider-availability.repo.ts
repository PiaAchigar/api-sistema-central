import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  providerAvailabilityAudit,
  providerAvailabilityExceptions,
  providerSaturdaySchedule,
  serviceProviderAvailability,
} from "../db/schema";
import { diffWeeklyAvailability, type WeeklyAvailabilityInput } from "../lib/availability";

/** Subconjunto de `Db` que también sirve dentro de una transacción (`tx`). */
type Tx = Pick<Db, "select" | "insert" | "update" | "delete">;

type AuditChangeType = "created" | "updated" | "deleted";
type AuditTable =
  | "service_provider_availability"
  | "provider_saturday_schedule"
  | "provider_availability_exceptions";

/** Escribe una fila de auditoría (reglas_negocio §3.4). `changedByUserId` queda en
 *  NULL: hoy no existe una resolución `auth.sub` (JWT) → `users.id` en ningún lado
 *  del sistema (ver spec de esta pieza — gap conocido, punto 15 del plan maestro). */
async function logAvailabilityChange(
  tx: Tx,
  params: {
    serviceProviderId: string;
    changeType: AuditChangeType;
    tableAffected: AuditTable;
    recordIdChanged: string;
    oldValues: Record<string, unknown> | null;
    newValues: Record<string, unknown> | null;
  },
) {
  await tx.insert(providerAvailabilityAudit).values({
    serviceProviderId: params.serviceProviderId,
    changeType: params.changeType,
    tableAffected: params.tableAffected,
    recordIdChanged: params.recordIdChanged,
    oldValues: params.oldValues,
    newValues: params.newValues,
    changedByUserId: null,
    changeReason: null,
  });
}

// ── Semanal (service_provider_availability) ─────────────────────────────────

/** Filas activas vigentes hoy, para prefill del panel. */
export async function listWeeklyAvailability(db: Tx, providerId: string) {
  const rows = await db
    .select({
      id: serviceProviderAvailability.id,
      dayOfWeek: serviceProviderAvailability.dayOfWeek,
      workStartTime: serviceProviderAvailability.workStartTime,
      workEndTime: serviceProviderAvailability.workEndTime,
    })
    .from(serviceProviderAvailability)
    .where(
      and(
        eq(serviceProviderAvailability.serviceProviderId, providerId),
        eq(serviceProviderAvailability.isActive, true),
      ),
    )
    .orderBy(asc(serviceProviderAvailability.dayOfWeek));
  return rows.map((r) => ({
    id: r.id,
    dayOfWeek: r.dayOfWeek as number,
    workStartTime: r.workStartTime as string,
    workEndTime: r.workEndTime as string,
  }));
}

/** Reconcilia el horario semanal respetando §1.4 (cerrar viejo + crear nuevo).
 *  Transaccional junto con el audit log: si falla el audit, se revierte todo. */
export async function setWeeklyAvailability(
  db: Db,
  providerId: string,
  desired: WeeklyAvailabilityInput[],
  today: string,
) {
  return db.transaction(async (tx) => {
    const current = await listWeeklyAvailability(tx, providerId);
    const { toCreate, toCloseIds } = diffWeeklyAvailability(current, desired);

    for (const id of toCloseIds) {
      const closedRow = current.find((c) => c.id === id)!;
      await tx
        .update(serviceProviderAvailability)
        .set({ isActive: false, validUntil: today })
        .where(eq(serviceProviderAvailability.id, id));
      await logAvailabilityChange(tx, {
        serviceProviderId: providerId,
        changeType: "updated",
        tableAffected: "service_provider_availability",
        recordIdChanged: id,
        oldValues: {
          isActive: true,
          dayOfWeek: closedRow.dayOfWeek,
          workStartTime: closedRow.workStartTime,
          workEndTime: closedRow.workEndTime,
        },
        newValues: { isActive: false, validUntil: today },
      });
    }

    for (const d of toCreate) {
      const rows = await tx
        .insert(serviceProviderAvailability)
        .values({
          serviceProviderId: providerId,
          dayOfWeek: d.dayOfWeek,
          workStartTime: d.workStartTime,
          workEndTime: d.workEndTime,
          validFrom: today,
          isActive: true,
        })
        .returning({ id: serviceProviderAvailability.id });
      await logAvailabilityChange(tx, {
        serviceProviderId: providerId,
        changeType: "created",
        tableAffected: "service_provider_availability",
        recordIdChanged: rows[0]!.id,
        oldValues: null,
        newValues: d,
      });
    }

    return listWeeklyAvailability(tx, providerId);
  });
}

// ── Sábados puntuales (provider_saturday_schedule) ──────────────────────────

export async function listSaturdaySchedule(db: Tx, providerId: string) {
  return db
    .select({
      id: providerSaturdaySchedule.id,
      saturdayDate: providerSaturdaySchedule.saturdayDate,
      isWorking: providerSaturdaySchedule.isWorking,
      workStartTime: providerSaturdaySchedule.workStartTime,
      workEndTime: providerSaturdaySchedule.workEndTime,
      notes: providerSaturdaySchedule.notes,
    })
    .from(providerSaturdaySchedule)
    .where(eq(providerSaturdaySchedule.serviceProviderId, providerId))
    .orderBy(asc(providerSaturdaySchedule.saturdayDate));
}

export type SaturdayInput = {
  saturdayDate: string;
  isWorking: boolean;
  workStartTime?: string | null;
  workEndTime?: string | null;
  notes?: string | null;
};

export async function addSaturdaySchedule(db: Db, providerId: string, data: SaturdayInput) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(providerSaturdaySchedule)
      .values({
        serviceProviderId: providerId,
        saturdayDate: data.saturdayDate,
        isWorking: data.isWorking,
        workStartTime: data.workStartTime ?? null,
        workEndTime: data.workEndTime ?? null,
        notes: data.notes ?? null,
      })
      .returning();
    const created = rows[0]!;
    await logAvailabilityChange(tx, {
      serviceProviderId: providerId,
      changeType: "created",
      tableAffected: "provider_saturday_schedule",
      recordIdChanged: created.id,
      oldValues: null,
      newValues: data,
    });
    return created;
  });
}

export async function deleteSaturdaySchedule(db: Db, providerId: string, rowId: string) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .delete(providerSaturdaySchedule)
      .where(
        and(
          eq(providerSaturdaySchedule.id, rowId),
          eq(providerSaturdaySchedule.serviceProviderId, providerId),
        ),
      )
      .returning();
    const deleted = rows[0] ?? null;
    if (deleted) {
      await logAvailabilityChange(tx, {
        serviceProviderId: providerId,
        changeType: "deleted",
        tableAffected: "provider_saturday_schedule",
        recordIdChanged: rowId,
        oldValues: deleted,
        newValues: null,
      });
    }
    return deleted;
  });
}

// ── Excepciones (provider_availability_exceptions) ──────────────────────────

export async function listExceptions(db: Tx, providerId: string) {
  return db
    .select({
      id: providerAvailabilityExceptions.id,
      dateException: providerAvailabilityExceptions.dateException,
      dateStart: providerAvailabilityExceptions.dateStart,
      dateEnd: providerAvailabilityExceptions.dateEnd,
      timeOverrideStart: providerAvailabilityExceptions.timeOverrideStart,
      timeOverrideEnd: providerAvailabilityExceptions.timeOverrideEnd,
      exceptionType: providerAvailabilityExceptions.exceptionType,
      reason: providerAvailabilityExceptions.reason,
      isWorking: providerAvailabilityExceptions.isWorking,
    })
    .from(providerAvailabilityExceptions)
    .where(eq(providerAvailabilityExceptions.serviceProviderId, providerId))
    .orderBy(asc(providerAvailabilityExceptions.createdAt));
}

export type ExceptionInput = {
  exceptionType: string;
  dateException?: string | null;
  dateStart?: string | null;
  dateEnd?: string | null;
  timeOverrideStart?: string | null;
  timeOverrideEnd?: string | null;
  reason?: string | null;
  isWorking: boolean;
};

export async function addException(db: Db, providerId: string, data: ExceptionInput) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(providerAvailabilityExceptions)
      .values({
        serviceProviderId: providerId,
        exceptionType: data.exceptionType,
        dateException: data.dateException ?? null,
        dateStart: data.dateStart ?? null,
        dateEnd: data.dateEnd ?? null,
        timeOverrideStart: data.timeOverrideStart ?? null,
        timeOverrideEnd: data.timeOverrideEnd ?? null,
        reason: data.reason ?? null,
        isWorking: data.isWorking,
      })
      .returning();
    const created = rows[0]!;
    await logAvailabilityChange(tx, {
      serviceProviderId: providerId,
      changeType: "created",
      tableAffected: "provider_availability_exceptions",
      recordIdChanged: created.id,
      oldValues: null,
      newValues: data,
    });
    return created;
  });
}

export async function deleteException(db: Db, providerId: string, rowId: string) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .delete(providerAvailabilityExceptions)
      .where(
        and(
          eq(providerAvailabilityExceptions.id, rowId),
          eq(providerAvailabilityExceptions.serviceProviderId, providerId),
        ),
      )
      .returning();
    const deleted = rows[0] ?? null;
    if (deleted) {
      await logAvailabilityChange(tx, {
        serviceProviderId: providerId,
        changeType: "deleted",
        tableAffected: "provider_availability_exceptions",
        recordIdChanged: rowId,
        oldValues: deleted,
        newValues: null,
      });
    }
    return deleted;
  });
}
