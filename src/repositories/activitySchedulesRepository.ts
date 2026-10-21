import { eq, and, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { activities, activitySchedules, serviceProviders } from "../db/schema/agenda";
import { badRequest, conflict, notFound } from "../lib/errors";

/**
 * Dos horarios activos de la misma actividad con el mismo día, hora de inicio, máquina y
 * proveedora serían la misma clase dos veces. Se ignora la vigencia: rechazar de más es lo seguro.
 */
async function rechazarHorarioDuplicado(
  t: Db,
  activityId: string,
  excluirId: string | null,
  dia: number | null,
  inicio: string | null,
  maquina: string | null,
  proveedora: string | null,
) {
  const [choque] = (await t.execute(sql`
    SELECT 1 AS x FROM activity_schedules
    WHERE activity_id = ${activityId}::uuid
      AND (${excluirId}::uuid IS NULL OR id <> ${excluirId}::uuid)
      AND is_active = true
      AND day_of_week = ${dia}
      AND start_time = ${inicio}::time
      AND machine_id IS NOT DISTINCT FROM ${maquina}::uuid
      AND service_provider_id IS NOT DISTINCT FROM ${proveedora}::uuid
    LIMIT 1
  `)) as unknown as { x: number }[];
  if (choque) {
    const [a] = await t.select({ name: activities.name }).from(activities).where(eq(activities.id, activityId)).limit(1);
    throw conflict(`Esa proveedora ya tiene un horario de ${a?.name ?? "la actividad"} a esa hora`);
  }
}

async function bloquearActividad(t: Db, activityId: string) {
  await t.select({ id: activities.id }).from(activities).where(eq(activities.id, activityId)).for("update").limit(1);
}

/**
 * ActivitySchedulesRepository — Data access layer for activity schedules
 * Handles CRUD operations on the activity_schedules table
 * Singleton with optional db injection via setDb(db)
 */
export class ActivitySchedulesRepository {
  private db: Db | null = null;

  /**
   * Inject database connection (called once at app startup)
   */
  setDb(db: Db): void {
    this.db = db;
  }

  /**
   * Ensure db is available
   */
  private getDb(): Db {
    if (!this.db) {
      throw new Error(
        "ActivitySchedulesRepository db not initialized. Call activitySchedulesRepository.setDb(db) at app startup."
      );
    }
    return this.db;
  }

  /** La proveedora existe y no está archivada. */
  async providerIsUsable(id: string): Promise<boolean> {
    const [p] = await this.getDb()
      .select({ status: serviceProviders.status })
      .from(serviceProviders)
      .where(eq(serviceProviders.id, id))
      .limit(1);
    return Boolean(p) && p!.status !== "inactive";
  }

  /**
   * Create a new activity schedule
   * @param data Schedule data to insert
   * @returns Full created schedule record
   */
  async create(data: {
    activityId: string;
    machineId?: string | null;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    validFrom?: string | null;
    validUntil?: string | null;
    capacity?: number | null;
    serviceProviderId?: string | null;
  }) {
    const db = this.getDb();
    // createdAt/updatedAt son `timestamp()` en modo Date: drizzle les llama
    // .toISOString() al mapear, así que un string ISO revienta con
    // "value.toISOString is not a function". Tiene que ser un Date.
    const now = new Date();
    return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await bloquearActividad(t, data.activityId);
    await rechazarHorarioDuplicado(
      t, data.activityId, null, data.dayOfWeek, data.startTime, data.machineId || null, data.serviceProviderId ?? null,
    );
    const rows = await t
      .insert(activitySchedules)
      .values({
        id: crypto.randomUUID(),
        activityId: data.activityId,
        machineId: data.machineId || null,
        dayOfWeek: data.dayOfWeek,
        // startTime/endTime son `time` y validFrom/validUntil `date`: columnas
        // de string, reciben "HH:MM" y "YYYY-MM-DD" en hora LOCAL del negocio.
        startTime: data.startTime,
        endTime: data.endTime,
        validFrom: data.validFrom ?? null,
        validUntil: data.validUntil ?? null,
        // Cupo del horario: null = sin límite declarado.
        capacity: data.capacity ?? null,
        // Proveedora del horario (1.60.0): cada horario tiene la suya.
        serviceProviderId: data.serviceProviderId ?? null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return rows[0] || null;
    });
  }

  /**
   * Get schedule by ID
   * @param id Schedule ID
   * @returns Schedule record or null if not found
   */
  async getById(id: string) {
    const db = this.getDb();
    const rows = await db
      .select()
      .from(activitySchedules)
      .where(eq(activitySchedules.id, id))
      .limit(1);

    return rows[0] || null;
  }

  /**
   * List schedules for an activity
   * @param activityId Activity ID
   * @param includeInactive true incluye también los pausados (isActive = false)
   * @returns Array of schedules
   */
  async listByActivityId(activityId: string, includeInactive = false) {
    const db = this.getDb();
    const condiciones = [eq(activitySchedules.activityId, activityId)];
    if (!includeInactive) condiciones.push(eq(activitySchedules.isActive, true));
    return db
      .select({ ...getTableColumns(activitySchedules), providerName: serviceProviders.fullName })
      .from(activitySchedules)
      .leftJoin(serviceProviders, eq(serviceProviders.id, activitySchedules.serviceProviderId))
      .where(and(...condiciones));
  }

  /**
   * Update schedule fields
   * @param id Schedule ID
   * @param data Partial schedule data to update
   * @returns Updated schedule record or null if not found
   */
  async update(
    id: string,
    data: {
      machineId?: string | null;
      dayOfWeek?: number;
      startTime?: string;
      endTime?: string;
      validFrom?: string | null;
      validUntil?: string | null;
      capacity?: number | null;
      serviceProviderId?: string | null;
      isActive?: boolean;
    }
  ) {
    const db = this.getDb();
    const updateData: Record<string, unknown> = {};

    if (data.machineId !== undefined) updateData.machineId = data.machineId;
    if (data.dayOfWeek !== undefined) updateData.dayOfWeek = data.dayOfWeek;
    if (data.startTime !== undefined) updateData.startTime = data.startTime;
    if (data.endTime !== undefined) updateData.endTime = data.endTime;
    if (data.validFrom !== undefined) updateData.validFrom = data.validFrom;
    if (data.validUntil !== undefined) updateData.validUntil = data.validUntil;
    if (data.capacity !== undefined) updateData.capacity = data.capacity;
    if (data.serviceProviderId !== undefined) updateData.serviceProviderId = data.serviceProviderId;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    updateData.updatedAt = new Date();

    // Todo en una transacción que toma la actividad FOR UPDATE primero (igual que las anotaciones).
    return db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [previo] = await t
        .select({ activityId: activitySchedules.activityId })
        .from(activitySchedules)
        .where(eq(activitySchedules.id, id))
        .limit(1);
      if (!previo) return null;
      await bloquearActividad(t, previo.activityId as string);

      // Con la actividad bloqueada se lee el horario tal como está ahora.
      const [actual] = await t.select().from(activitySchedules).where(eq(activitySchedules.id, id)).limit(1);
      if (!actual) throw notFound("Activity schedule");

      const nueva = data.serviceProviderId !== undefined ? data.serviceProviderId : actual.serviceProviderId ?? null;
      const cambiaProveedora = nueva !== (actual.serviceProviderId ?? null);
      const dia = data.dayOfWeek ?? actual.dayOfWeek;
      const inicio = data.startTime ?? actual.startTime;
      const maquina = data.machineId !== undefined ? data.machineId : actual.machineId;
      const cambiaHorario =
        dia !== actual.dayOfWeek || inicio !== actual.startTime || (maquina ?? null) !== (actual.machineId ?? null);
      const quedaActivo = data.isActive ?? actual.isActive;
      const reactiva = data.isActive === true && actual.isActive !== true;

      if (cambiaProveedora && cambiaHorario) {
        throw badRequest("Cambiá la proveedora y el día u horario por separado");
      }
      if (quedaActivo && (cambiaProveedora || cambiaHorario || reactiva)) {
        await rechazarHorarioDuplicado(t, actual.activityId as string, id, dia, inicio, maquina ?? null, nueva);
      }

      if (cambiaProveedora) {
        // Turnos futuros de ESTE horario: misma actividad, mismo día y hora en ART, misma máquina,
        // la proveedora anterior y fecha dentro de la vigencia.
        await t.execute(sql`
          UPDATE appointments
          SET service_provider_id = ${nueva}::uuid, updated_at = now()
          WHERE activity_id = ${actual.activityId}::uuid
            AND status <> 'cancelled'
            AND appointment_start > (now() AT TIME ZONE 'UTC')
            AND EXTRACT(DOW FROM (appointment_start AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires'))::int = ${actual.dayOfWeek}
            AND (appointment_start AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::time = ${actual.startTime}::time
            AND machine_id IS NOT DISTINCT FROM ${actual.machineId}::uuid
            AND service_provider_id IS NOT DISTINCT FROM ${actual.serviceProviderId ?? null}::uuid
            AND (${actual.validFrom ?? null}::date IS NULL
                 OR (appointment_start AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= ${actual.validFrom ?? null}::date)
            AND (${actual.validUntil ?? null}::date IS NULL
                 OR (appointment_start AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= ${actual.validUntil ?? null}::date)
        `);
      }

      const rows = await t
        .update(activitySchedules)
        .set(updateData)
        .where(eq(activitySchedules.id, id))
        .returning();
      return rows[0] || null;
    });
  }

  /**
   * Soft-delete: set isActive to false
   * @param id Schedule ID
   * @returns Updated schedule record or null if not found
   */
  async softDelete(id: string) {
    const db = this.getDb();
    const rows = await db
      .update(activitySchedules)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(activitySchedules.id, id))
      .returning();

    return rows[0] || null;
  }
}

/**
 * Singleton instance of ActivitySchedulesRepository
 * Call activitySchedulesRepository.setDb(db) at app startup to inject the database connection
 * Usage: activitySchedulesRepository.getById(...) after db is set
 */
export const activitySchedulesRepository = new ActivitySchedulesRepository();
