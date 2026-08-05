import { eq, and, gte, lte } from "drizzle-orm";
import type { Db } from "../db/client";
import { trainingSubscriptions, activityAttendance } from "../db/schema/agenda";

/**
 * TrainingSubscriptionsRepository — Data access layer for training subscriptions
 * Handles CRUD operations on training_subscriptions and activity_attendance tables
 * Singleton with optional db injection via setDb(db)
 */
export class TrainingSubscriptionsRepository {
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
        "TrainingSubscriptionsRepository db not initialized. Call trainingSubscriptionsRepository.setDb(db) at app startup."
      );
    }
    return this.db;
  }

  /**
   * Create a new training subscription
   * @param data Subscription data to insert
   * @returns Full created subscription record
   */
  async create(data: {
    activityId: string;
    customerId: string;
    subscriptionStartDate: string; // ISO date string (YYYY-MM-DD)
    subscriptionEndDate?: string | null; // ISO date string
    status: "active" | "paused" | "cancelled";
    monthlyAmount: number | string;
    notes?: string | null;
  }) {
    const db = this.getDb();
    const now = new Date().toISOString();
    const rows = await db
      .insert(trainingSubscriptions)
      .values({
        id: crypto.randomUUID(),
        activityId: data.activityId,
        customerId: data.customerId,
        subscriptionStartDate: data.subscriptionStartDate as any,
        subscriptionEndDate: (data.subscriptionEndDate || null) as any,
        status: data.status,
        monthlyAmount:
          typeof data.monthlyAmount === "string"
            ? data.monthlyAmount
            : String(data.monthlyAmount),
        notes: data.notes || null,
        createdAt: now as any,
        updatedAt: now as any,
      })
      .returning();

    return rows[0] || null;
  }

  /**
   * Get subscription by ID
   * @param id Subscription ID
   * @returns Subscription record or null if not found
   */
  async getById(id: string) {
    const db = this.getDb();
    const rows = await db
      .select()
      .from(trainingSubscriptions)
      .where(eq(trainingSubscriptions.id, id))
      .limit(1);

    return rows[0] || null;
  }

  /**
   * List subscriptions by customer ID
   * @param customerId Customer ID
   * @returns Array of subscriptions for the customer
   */
  async listByCustomerId(customerId: string) {
    const db = this.getDb();
    return db
      .select()
      .from(trainingSubscriptions)
      .where(eq(trainingSubscriptions.customerId, customerId));
  }

  /**
   * Update subscription fields
   * @param id Subscription ID
   * @param data Partial subscription data to update
   * @returns Updated subscription record or null if not found
   */
  async update(
    id: string,
    data: {
      status?: "active" | "paused" | "cancelled";
      monthlyAmount?: number | string;
      subscriptionEndDate?: string | null;
      notes?: string | null;
    }
  ) {
    const db = this.getDb();
    const updateData: Record<string, unknown> = {};

    if (data.status !== undefined) updateData.status = data.status;
    if (data.monthlyAmount !== undefined) {
      updateData.monthlyAmount =
        typeof data.monthlyAmount === "string"
          ? data.monthlyAmount
          : String(data.monthlyAmount);
    }
    if (data.subscriptionEndDate !== undefined) {
      updateData.subscriptionEndDate = data.subscriptionEndDate || null;
    }
    if (data.notes !== undefined) updateData.notes = data.notes;
    updateData.updatedAt = new Date().toISOString();

    const rows = await db
      .update(trainingSubscriptions)
      .set(updateData)
      .where(eq(trainingSubscriptions.id, id))
      .returning();

    return rows[0] || null;
  }

  /**
   * Get attendance records for a subscription in a specific month
   * @param subscriptionId Subscription ID
   * @param year Year (e.g., 2026)
   * @param month Month (1-12)
   * @returns Array of attendance records
   */
  async getAttendanceForMonth(
    subscriptionId: string,
    year: number,
    month: number
  ) {
    const db = this.getDb();

    // Build date range for the month
    const startDate = new Date(year, month - 1, 1).toISOString().split("T")[0];
    const endDate = new Date(year, month, 0).toISOString().split("T")[0];

    return db
      .select()
      .from(activityAttendance)
      .where(
        and(
          eq(activityAttendance.subscriptionId, subscriptionId),
          gte(activityAttendance.classDate, startDate as any),
          lte(activityAttendance.classDate, endDate as any)
        )
      );
  }
}

/**
 * Singleton instance of TrainingSubscriptionsRepository
 * Call trainingSubscriptionsRepository.setDb(db) at app startup to inject the database connection
 * Usage: trainingSubscriptionsRepository.getById(...) after db is set
 */
export const trainingSubscriptionsRepository = new TrainingSubscriptionsRepository();
