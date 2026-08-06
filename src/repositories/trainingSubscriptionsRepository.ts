import { eq, and, gte, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { trainingSubscriptions, activityAttendance } from "../db/schema/agenda";

/**
 * Raw row shape returned by the admin/list query (snake_case, as it comes
 * straight from Postgres — see TrainingSubscriptionsRepository.listWithAttendance)
 */
export type SubscriptionWithAttendanceRow = {
  id: string;
  customer_id: string;
  activity_id: string;
  activity_name: string;
  activity_type: string;
  classes_per_month: number;
  subscription_start_date: string;
  subscription_end_date: string | null;
  monthly_amount: string;
  status: string;
  notes: string | null;
  attendance_this_month: number;
  paid_date: string | null;
};

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
        subscriptionStartDate: data.subscriptionStartDate,
        subscriptionEndDate: data.subscriptionEndDate || null,
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
   * List subscriptions with current-month attendance for the admin panel.
   *
   * One query: joins ACTIVITIES for name/type/classesPerMonth, uses a
   * LATERAL join to count this month's `scheduled` appointments per
   * subscription (customer + activity), and LEFT JOINs the current
   * billing cycle (subscription_billing_cycles) for payment_date.
   *
   * "This month" and "day of month" (used for the paidStatus filter) are
   * both computed in UTC to stay consistent with how appointment_start /
   * created_at are stored (see feedback_seed_timestamps memory: timestamps
   * are always UTC).
   *
   * @param filters Optional filters: activityId, status, paidStatus
   * @returns Array of raw rows (snake_case) — mapping to SubscriptionWithAttendance happens in the service
   */
  async listWithAttendance(filters: {
    activityId?: string;
    status?: string;
    paidStatus?: string;
  }): Promise<SubscriptionWithAttendanceRow[]> {
    const db = this.getDb();

    const conditions = [];
    if (filters.activityId) {
      conditions.push(sql`ts.activity_id = ${filters.activityId}`);
    }
    if (filters.status) {
      conditions.push(sql`ts.status = ${filters.status}`);
    }
    if (filters.paidStatus) {
      // Mirrors the paidStatus logic computed in the service layer
      // (TrainingSubscriptionsService.computePaidStatus) — kept in sync manually.
      conditions.push(sql`
        (CASE
          WHEN sbc.payment_date IS NOT NULL THEN 'paid'
          WHEN EXTRACT(DAY FROM (now() AT TIME ZONE 'UTC')) > 10 THEN 'overdue'
          ELSE 'pending'
        END) = ${filters.paidStatus}
      `);
    }

    const whereClause =
      conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

    const rows = await db.execute<SubscriptionWithAttendanceRow>(sql`
      WITH current_month AS (
        SELECT
          date_trunc('month', (now() AT TIME ZONE 'UTC'))::date AS month_start,
          (date_trunc('month', (now() AT TIME ZONE 'UTC')) + INTERVAL '1 month')::date AS month_end,
          to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM') AS billing_month
      )
      SELECT
        ts.id,
        ts.customer_id,
        ts.activity_id,
        a.name AS activity_name,
        a.activity_type,
        a.classes_per_month,
        ts.subscription_start_date,
        ts.subscription_end_date,
        ts.monthly_amount,
        ts.status,
        ts.notes,
        COALESCE(att.attendance_count, 0)::int AS attendance_this_month,
        sbc.payment_date AS paid_date
      FROM training_subscriptions ts
      JOIN activities a ON a.id = ts.activity_id
      CROSS JOIN current_month cm
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS attendance_count
        FROM appointments ap
        WHERE ap.customer_id = ts.customer_id
          AND ap.activity_id = ts.activity_id
          AND ap.status = 'scheduled'
          AND ap.appointment_start >= cm.month_start
          AND ap.appointment_start < cm.month_end
      ) att ON true
      LEFT JOIN subscription_billing_cycles sbc
        ON sbc.training_subscription_id = ts.id
        AND sbc.billing_month = cm.billing_month
      ${whereClause}
      ORDER BY ts.created_at DESC
    `);

    return rows as unknown as SubscriptionWithAttendanceRow[];
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

    // Build date range for the month as YYYY-MM-DD strings (UTC)
    const startDateStr = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDateStr = `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;

    return db
      .select()
      .from(activityAttendance)
      .where(
        and(
          eq(activityAttendance.subscriptionId, subscriptionId),
          gte(activityAttendance.classDate, startDateStr),
          lte(activityAttendance.classDate, endDateStr)
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
