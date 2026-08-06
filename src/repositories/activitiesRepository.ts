import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { activities } from "../db/schema/agenda";

/**
 * ActivitiesRepository — Data access layer for activities
 * Handles CRUD operations on the activities table
 * Singleton with optional db injection via setDb(db)
 */
export class ActivitiesRepository {
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
        "ActivitiesRepository db not initialized. Call activitiesRepository.setDb(db) at app startup."
      );
    }
    return this.db;
  }

  /**
   * Create a new activity
   * @param data Activity data to insert
   * @returns Full created activity record
   */
  async create(data: {
    name: string;
    description?: string | null;
    activityType: "class" | "machine";
    serviceProviderId?: string | null;
    classesPerMonth: number;
    monthlyBasePrice: number | string;
  }) {
    const db = this.getDb();
    const now = new Date().toISOString();
    const rows = await db
      .insert(activities)
      .values({
        id: crypto.randomUUID(),
        name: data.name,
        description: data.description || null,
        activityType: data.activityType,
        serviceProviderId: data.serviceProviderId || null,
        classesPerMonth: data.classesPerMonth,
        monthlyBasePrice:
          typeof data.monthlyBasePrice === "string"
            ? data.monthlyBasePrice
            : String(data.monthlyBasePrice),
        isActive: true,
        createdAt: now as any,
        updatedAt: now as any,
      })
      .returning();

    return rows[0] || null;
  }

  /**
   * Get activity by ID
   * @param id Activity ID
   * @returns Activity record or null if not found
   */
  async getById(id: string) {
    const db = this.getDb();
    const rows = await db
      .select()
      .from(activities)
      .where(eq(activities.id, id))
      .limit(1);

    return rows[0] || null;
  }

  /**
   * List all active activities (isActive = true)
   * @returns Array of active activities
   */
  async listActive() {
    const db = this.getDb();
    return db
      .select()
      .from(activities)
      .where(eq(activities.isActive, true));
  }

  /**
   * List all activities regardless of active status
   * @returns Array of all activities
   */
  async listAll() {
    const db = this.getDb();
    return db.select().from(activities);
  }

  /**
   * Update activity fields
   * @param id Activity ID
   * @param data Partial activity data to update
   * @returns Updated activity record or null if not found
   */
  async update(
    id: string,
    data: {
      name?: string;
      description?: string | null;
      activityType?: "class" | "machine";
      serviceProviderId?: string | null;
      classesPerMonth?: number;
      monthlyBasePrice?: number | string;
    }
  ) {
    const db = this.getDb();
    const updateData: Record<string, unknown> = {};

    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.activityType !== undefined) updateData.activityType = data.activityType;
    if (data.serviceProviderId !== undefined)
      updateData.serviceProviderId = data.serviceProviderId;
    if (data.classesPerMonth !== undefined)
      updateData.classesPerMonth = data.classesPerMonth;
    if (data.monthlyBasePrice !== undefined) {
      updateData.monthlyBasePrice =
        typeof data.monthlyBasePrice === "string"
          ? data.monthlyBasePrice
          : String(data.monthlyBasePrice);
    }
    updateData.updatedAt = new Date().toISOString();

    const rows = await db
      .update(activities)
      .set(updateData)
      .where(eq(activities.id, id))
      .returning();

    return rows[0] || null;
  }

  /**
   * Soft-delete: set isActive to false
   * @param id Activity ID
   * @returns Updated activity record or null if not found
   */
  async softDelete(id: string) {
    const db = this.getDb();
    const rows = await db
      .update(activities)
      .set({ isActive: false, updatedAt: new Date().toISOString() as any })
      .where(eq(activities.id, id))
      .returning();

    return rows[0] || null;
  }

  /**
   * Hard-delete: permanently remove activity from database
   * @param id Activity ID
   * @returns true if deleted, false if not found
   */
  async hardDelete(id: string) {
    const db = this.getDb();
    const rows = await db
      .delete(activities)
      .where(eq(activities.id, id))
      .returning();

    return rows.length > 0;
  }
}

/**
 * Singleton instance of ActivitiesRepository
 * Call activitiesRepository.setDb(db) at app startup to inject the database connection
 * Usage: activitiesRepository.getById(...) after db is set
 */
export const activitiesRepository = new ActivitiesRepository();
