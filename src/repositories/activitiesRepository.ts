import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { activities } from "../db/schema/agenda";

/**
 * ActivitiesRepository — Data access layer for activities
 * Handles CRUD operations on the activities table
 */
export class ActivitiesRepository {
  constructor(private db: Db) {}

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
    const rows = await this.db
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
        createdAt: new Date(),
        updatedAt: new Date(),
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
    const rows = await this.db
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
    return this.db
      .select()
      .from(activities)
      .where(eq(activities.isActive, true));
  }

  /**
   * List all activities regardless of active status
   * @returns Array of all activities
   */
  async listAll() {
    return this.db.select().from(activities);
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
    updateData.updatedAt = new Date();

    const rows = await this.db
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
    const rows = await this.db
      .update(activities)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(activities.id, id))
      .returning();

    return rows[0] || null;
  }
}

/**
 * Factory function to create an ActivitiesRepository instance
 * Usage: const repo = createActivitiesRepository(db)
 */
export function createActivitiesRepository(db: Db): ActivitiesRepository {
  return new ActivitiesRepository(db);
}
