import { eq, and } from "drizzle-orm";
import type { Db } from "../db/client";
import { activitySchedules } from "../db/schema/agenda";

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
  }) {
    const db = this.getDb();
    // createdAt/updatedAt son `timestamp()` en modo Date: drizzle les llama
    // .toISOString() al mapear, así que un string ISO revienta con
    // "value.toISOString is not a function". Tiene que ser un Date.
    const now = new Date();
    const rows = await db
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
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return rows[0] || null;
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
   * List all active schedules for an activity
   * @param activityId Activity ID
   * @returns Array of active schedules
   */
  async listByActivityId(activityId: string) {
    const db = this.getDb();
    return db
      .select()
      .from(activitySchedules)
      .where(
        and(
          eq(activitySchedules.activityId, activityId),
          eq(activitySchedules.isActive, true)
        )
      );
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
    updateData.updatedAt = new Date();

    const rows = await db
      .update(activitySchedules)
      .set(updateData)
      .where(eq(activitySchedules.id, id))
      .returning();

    return rows[0] || null;
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
