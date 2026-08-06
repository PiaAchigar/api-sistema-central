import { eq, and, gte, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { todayLocal } from "../lib/time";
import {
  trainingSubscriptions,
  activityAttendance,
  subscriptionBillingCycles,
} from "../db/schema/agenda";

/**
 * Raw row shape returned by the admin/list query (snake_case, as it comes
 * straight from Postgres — see TrainingSubscriptionsRepository.listWithAttendance)
 */
export type SubscriptionWithAttendanceRow = {
  id: string;
  customer_id: string;
  customer_name: string | null;
  activity_id: string;
  activity_name: string;
  activity_type: string;
  classes_per_month: number;
  subscription_start_date: string;
  subscription_end_date: string | null;
  monthly_amount: string;
  status: string;
  notes: string | null;
  /** Asistencias reales del mes: activity_attendance.attended = true */
  attended_this_month: number;
  /** Clases agendadas vigentes del mes: appointments.status = 'scheduled' */
  scheduled_this_month: number;
  paid_date: string | null;
};

/**
 * Una fila del roster de una clase: un cliente agendado a (actividad, horario),
 * con su suscripción activa y su asistencia ya registrada (si la hay).
 */
export type ClassRosterRow = {
  appointment_id: string;
  appointment_status: string | null;
  customer_id: string | null;
  customer_name: string | null;
  /** NULL si el cliente no tiene suscripción activa a esta actividad */
  subscription_id: string | null;
  subscription_status: string | null;
  /** NULL si todavía no se registró nada para esa clase */
  attended: boolean | null;
  class_date: string;
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
    // created_at/updated_at are `timestamp` columns in default (Date) mode — Drizzle's
    // mapToDriverValue calls .toISOString() on the value itself, so it must be a Date
    // instance, not an already-stringified ISO string (fixed alongside the identical bug
    // in update() / upsertBillingCyclePaymentDate() below).
    const now = new Date();
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
        createdAt: now,
        updatedAt: now,
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
    // Date instance, not .toISOString() string — see note in create() above.
    updateData.updatedAt = new Date();

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
   * @param filters Optional filters: id, activityId, status, paidStatus
   * @returns Array of raw rows (snake_case) — mapping to SubscriptionWithAttendance happens in the service
   */
  async listWithAttendance(filters: {
    id?: string;
    activityId?: string;
    status?: string;
    paidStatus?: string;
  }): Promise<SubscriptionWithAttendanceRow[]> {
    const db = this.getDb();

    const conditions = [];
    if (filters.id) {
      conditions.push(sql`ts.id = ${filters.id}`);
    }
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
          WHEN EXTRACT(DAY FROM (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')) > 10
            THEN 'overdue'
          ELSE 'pending'
        END) = ${filters.paidStatus}
      `);
    }

    const whereClause =
      conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

    const rows = await db.execute<SubscriptionWithAttendanceRow>(sql`
      -- El mes se recorta en hora LOCAL del negocio (ART, -03:00), no en UTC.
      -- Con UTC, una clase del 31/8 a las 21:00 ART (= 1/9 00:00 UTC) caía en
      -- septiembre y el cupo del mes daba mal. Ver src/lib/time.ts.
      WITH current_month AS (
        SELECT
          date_trunc('month', (now() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::date
            AS month_start,
          (date_trunc('month', (now() AT TIME ZONE 'America/Argentina/Buenos_Aires'))
            + INTERVAL '1 month')::date AS month_end,
          to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires'), 'YYYY-MM')
            AS billing_month
      )
      SELECT
        ts.id,
        ts.customer_id,
        ct.name AS customer_name,
        ts.activity_id,
        a.name AS activity_name,
        a.activity_type,
        a.classes_per_month,
        ts.subscription_start_date,
        ts.subscription_end_date,
        ts.monthly_amount,
        ts.status,
        ts.notes,
        COALESCE(att.attended_count, 0)::int AS attended_this_month,
        COALESCE(sch.scheduled_count, 0)::int AS scheduled_this_month,
        sbc.payment_date AS paid_date
      FROM training_subscriptions ts
      JOIN activities a ON a.id = ts.activity_id
      -- El nombre del cliente vive en CONTACTS (customers.contact_id -> contacts.name),
      -- igual que en customerSummary de customers.repo.ts.
      -- LEFT JOIN a propósito: un customer sin contacto no debe desaparecer de la grilla.
      LEFT JOIN customers cu ON cu.id = ts.customer_id
      LEFT JOIN contacts ct ON ct.id = cu.contact_id
      CROSS JOIN current_month cm
      -- Asistencias REALES del mes. Única fuente de verdad: lo que el admin
      -- tildó desde la Agenda (activity_attendance.attended = true). Se cuenta
      -- por subscription_id, que es la clave de esa tabla.
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS attended_count
        FROM activity_attendance aa
        WHERE aa.subscription_id = ts.id
          AND aa.attended = true
          AND aa.class_date >= cm.month_start
          AND aa.class_date < cm.month_end
      ) att ON true
      -- Clases AGENDADAS vigentes del mes: consumen cupo del plan aunque
      -- todavía no hayan ocurrido. Los turnos cancelados quedan fuera (status
      -- deja de ser 'scheduled'), así que cancelar devuelve el cupo.
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS scheduled_count
        FROM appointments ap
        WHERE ap.customer_id = ts.customer_id
          AND ap.activity_id = ts.activity_id
          AND ap.status = 'scheduled'
          -- appointment_start guarda UTC; el corte del mes es local, así que
          -- se lleva el turno a hora local antes de compararlo.
          AND (ap.appointment_start AT TIME ZONE 'UTC'
                AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= cm.month_start
          AND (ap.appointment_start AT TIME ZONE 'UTC'
                AT TIME ZONE 'America/Argentina/Buenos_Aires')::date < cm.month_end
      ) sch ON true
      LEFT JOIN subscription_billing_cycles sbc
        ON sbc.training_subscription_id = ts.id
        AND sbc.billing_month = cm.billing_month
      ${whereClause}
      ORDER BY ts.created_at DESC
    `);

    return rows as unknown as SubscriptionWithAttendanceRow[];
  }

  /**
   * Get a single subscription with current-month attendance/payment info,
   * for the admin PATCH endpoint response. Reuses listWithAttendance's id filter
   * so the enrichment SQL (attendance count, billing cycle join) stays in one place.
   * @param id Subscription ID
   * @returns Raw row (snake_case) or null if not found
   */
  async getByIdWithAttendance(id: string): Promise<SubscriptionWithAttendanceRow | null> {
    const rows = await this.listWithAttendance({ id });
    return rows[0] || null;
  }

  /**
   * Lista de clientes de una clase concreta, con su estado de asistencia.
   *
   * En este modelo `appointments.customer_id` es UNO solo, así que una actividad
   * grupal son N turnos distintos con el mismo `activity_id` y el mismo
   * `appointment_start`. Por eso la clase se identifica por (actividad, horario)
   * y no por un appointment id.
   *
   * `subscription_id` puede venir NULL: alguien puede estar agendado a la clase
   * sin suscripción activa (turno suelto). Esos casos no se pueden tildar,
   * porque activity_attendance cuelga de la suscripción — la capa de servicio
   * lo marca como no tildable en vez de romper.
   *
   * @param activityId Actividad de la clase
   * @param startsAt Timestamp exacto de inicio (ISO)
   */
  async getClassRoster(
    activityId: string,
    startsAt: string
  ): Promise<ClassRosterRow[]> {
    const db = this.getDb();

    const rows = await db.execute<ClassRosterRow>(sql`
      SELECT
        ap.id           AS appointment_id,
        ap.status       AS appointment_status,
        ap.customer_id,
        ct.name         AS customer_name,
        ts.id           AS subscription_id,
        ts.status       AS subscription_status,
        aa.attended     AS attended,
        -- Fecha LOCAL de la clase: una clase del 31/8 a las 21:00 ART es
        -- 1/9 en UTC, y quedaría registrada en el día equivocado.
        (ap.appointment_start AT TIME ZONE 'UTC'
          AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS class_date
      FROM appointments ap
      LEFT JOIN customers cu ON cu.id = ap.customer_id
      LEFT JOIN contacts ct ON ct.id = cu.contact_id
      LEFT JOIN training_subscriptions ts
        ON ts.customer_id = ap.customer_id
       AND ts.activity_id = ap.activity_id
       AND ts.status = 'active'
      LEFT JOIN activity_attendance aa
        ON aa.subscription_id = ts.id
       AND aa.class_date = (ap.appointment_start AT TIME ZONE 'UTC'
             AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
      WHERE ap.activity_id = ${activityId}
        AND ap.appointment_start = ${startsAt}
        AND ap.status <> 'cancelled'
      ORDER BY ct.name NULLS LAST
    `);

    return rows as unknown as ClassRosterRow[];
  }

  /**
   * Marca (o desmarca) la asistencia de varias suscripciones a una misma fecha
   * de clase, en una sola sentencia.
   *
   * Upsert vía el UNIQUE (subscription_id, class_date) que crea la migración
   * 1.23.0: guardar el mismo modal dos veces actualiza, no duplica — si no, el
   * contador de asistencias del mes contaría de más.
   */
  async upsertAttendance(
    activityId: string,
    classDate: string,
    entries: { subscriptionId: string; attended: boolean }[]
  ): Promise<void> {
    if (entries.length === 0) return;
    const db = this.getDb();

    const values = entries.map(
      (e) =>
        sql`(gen_random_uuid(), ${e.subscriptionId}::uuid, ${activityId}::uuid, ${classDate}::date, ${e.attended})`
    );

    await db.execute(sql`
      INSERT INTO activity_attendance
        (id, subscription_id, activity_id, class_date, attended)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (subscription_id, class_date) DO UPDATE
        SET attended = EXCLUDED.attended,
            updated_at = now()
    `);
  }

  /**
   * Create or update this month's billing cycle row for a training subscription,
   * setting payment_date (and is_paid accordingly). Used by the admin PATCH
   * endpoint (PATCH /api/training-subscriptions/:id/admin) when paidDate is
   * included in the request body.
   *
   * Atomic upsert: migración 1.22.1 crea el índice UNIQUE parcial
   * uq_billing_cycles_training_subscription_month sobre
   * (training_subscription_id, billing_month) WHERE training_subscription_id
   * IS NOT NULL, así que ON CONFLICT resuelve la carrera entre dos requests
   * simultáneos que antes duplicaban el ciclo del mes.
   *
   * @param trainingSubscriptionId Training subscription ID
   * @param paymentDate YYYY-MM-DD string to mark as paid, or null to clear payment
   */
  async upsertBillingCyclePaymentDate(
    trainingSubscriptionId: string,
    paymentDate: string | null
  ): Promise<void> {
    const db = this.getDb();

    const now = new Date();
    // El mes de facturación se decide en hora LOCAL del negocio: el 31/8 a las
    // 22:00 ART ya es 1/9 en UTC, y con getUTCMonth() el pago se habría
    // imputado a septiembre. Ver src/lib/time.ts.
    const [year, month] = todayLocal().split("-").map(Number);
    const billingMonth = `${year}-${String(month).padStart(2, "0")}`;
    const billingPeriodStart = `${billingMonth}-01`;
    // El período de facturación es el mes calendario completo (1 al 28/29/30/31).
    // El día 10 es el vencimiento de gracia para el pago, NO el fin del período:
    // no confundirlos. Día 0 del mes siguiente = último día de este mes.
    const lastDayOfMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
    const billingPeriodEnd = `${billingMonth}-${String(lastDayOfMonth).padStart(2, "0")}`;
    const isPaid = paymentDate !== null;
    // payment_date/created_at/updated_at are `timestamp` columns in default (Date) mode —
    // Drizzle's mapToDriverValue calls .toISOString() on the value itself, so it must be
    // a Date instance, not an ISO string (an ISO string blows up with
    // "value.toISOString is not a function").
    const paymentDateValue = paymentDate ? new Date(paymentDate) : null;

    await db
      .insert(subscriptionBillingCycles)
      .values({
        id: crypto.randomUUID(),
        trainingSubscriptionId,
        billingMonth,
        billingPeriodStart,
        billingPeriodEnd,
        isPaid,
        paymentDate: paymentDateValue,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          subscriptionBillingCycles.trainingSubscriptionId,
          subscriptionBillingCycles.billingMonth,
        ],
        // Debe coincidir con el WHERE del índice parcial para que Postgres lo elija.
        targetWhere: sql`${subscriptionBillingCycles.trainingSubscriptionId} IS NOT NULL`,
        set: {
          paymentDate: paymentDateValue,
          isPaid,
          updatedAt: now,
        },
      });
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
