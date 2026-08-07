import { notFound, badRequest, conflict } from "../lib/errors";
import { todayLocal, utcToLocalDateString } from "../lib/time";
import { activitiesService } from "./activitiesService";
import { eq } from "drizzle-orm";
import { customers } from "../db/schema/crm";
import type { Db } from "../db/client";
import type {
  TrainingSubscriptionsRepository,
  SubscriptionWithAttendanceRow,
  ClassRosterRow,
} from "../repositories/trainingSubscriptionsRepository";

/**
 * Un cliente en el roster de una clase, tal como lo consume la Agenda.
 * `canMark` en false = no se le puede tildar asistencia (no tiene suscripción
 * activa a esta actividad), y `reason` explica por qué para mostrarlo en el modal.
 */
export interface ClassRosterEntry {
  appointmentId: string;
  customerId: string | null;
  customerName: string;
  subscriptionId: string | null;
  attended: boolean;
  canMark: boolean;
  reason: string | null;
}

/**
 * ¿Es este error una violación del índice UNIQUE `constraintName`?
 * postgres.js expone el SQLSTATE en `.code` (23505 = unique_violation) y el
 * nombre del índice en `.constraint_name`. Se chequean ambos para no confundir
 * una unique distinta sobre la misma tabla.
 */
function isUniqueViolation(err: unknown, constraintName: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown };
  return e.code === "23505" && e.constraint_name === constraintName;
}

/**
 * Subscription row enriched with this-month attendance and payment status,
 * used by the admin panel (GET /api/training-subscriptions/admin/list)
 */
export interface SubscriptionWithAttendance {
  id: string;
  customerId: string;
  customerName: string;
  activityId: string;
  activityName: string;
  activityType: "class" | "machine";
  classesPerMonth: number;
  subscriptionStartDate: string;
  subscriptionEndDate: string | null;
  monthlyAmount: number;
  status: "active" | "paused" | "cancelled";
  notes: string | null;
  /** Clases a las que el cliente REALMENTE fue (tildadas desde la Agenda) */
  attendedThisMonth: number;
  /** Clases agendadas vigentes este mes (consumen cupo aunque no hayan ocurrido) */
  scheduledThisMonth: number;
  /** Cupo del plan que queda por agendar: classesPerMonth - scheduledThisMonth */
  classesRemainingThisMonth: number;
  paidDate: string | null;
  paidStatus: "paid" | "pending" | "overdue";
}

/**
 * TrainingSubscriptionsService — Business logic layer for training subscriptions
 * Validates business rules and delegates to repository
 * Singleton with repository dependency injection
 */
export class TrainingSubscriptionsService {
  private db: Db | null = null;

  constructor(private repository: TrainingSubscriptionsRepository) {}

  /**
   * Inject database connection (called once at app startup)
   */
  setDb(db: Db): void {
    this.db = db;
  }

  /**
   * Ensure db is available for customer validation
   */
  private getDb(): Db {
    if (!this.db) {
      throw new Error(
        "TrainingSubscriptionsService db not initialized. Call trainingSubscriptionsService.setDb(db) at app startup."
      );
    }
    return this.db;
  }

  /**
   * Validate that a customer exists
   * @param customerId Customer ID to validate
   * @throws notFound if customer doesn't exist
   */
  private async validateCustomerExists(customerId: string): Promise<void> {
    try {
      const db = this.getDb();
      const customer = await db
        .select()
        .from(customers)
        .where(eq(customers.id, customerId))
        .limit(1);

      if (!customer || customer.length === 0) {
        // notFound() ya agrega " not found" — pasarle la frase entera daba
        // "Customer not found not found" en pantalla.
        throw notFound("Customer");
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        throw err;
      }
      // If db error, log but don't fail — customer validation is best-effort
      console.warn("[customer-validation] Could not validate customer:", customerId);
    }
  }

  /**
   * Validate subscription dates
   * - subscriptionStartDate must be in YYYY-MM-DD format
   * - subscriptionEndDate (if provided) must be >= subscriptionStartDate
   *
   * @throws badRequest if validation fails
   */
  private validateDates(
    startDate: string,
    endDate?: string | null
  ): void {
    // Basic format validation
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate)) {
      throw badRequest("subscriptionStartDate must be in YYYY-MM-DD format");
    }

    if (endDate) {
      if (!dateRegex.test(endDate)) {
        throw badRequest("subscriptionEndDate must be in YYYY-MM-DD format");
      }

      // End date must be >= start date
      if (new Date(endDate) < new Date(startDate)) {
        throw badRequest("subscriptionEndDate must be greater than or equal to subscriptionStartDate");
      }
    }
  }

  /**
   * Create a new training subscription with validation
   * @param data Subscription data to create
   * @returns Full created subscription record
   * @throws badRequest if validation fails
   * @throws notFound if activity doesn't exist
   */
  async createSubscription(data: {
    activityId: string;
    customerId: string;
    subscriptionStartDate: string;
    subscriptionEndDate?: string | null;
    monthlyAmount: number | string;
    notes?: string | null;
  }) {
    // Validate dates
    this.validateDates(data.subscriptionStartDate, data.subscriptionEndDate);

    // Validate customer exists
    await this.validateCustomerExists(data.customerId);

    // Validate activity exists and meets subscription requirements
    let activity;
    try {
      activity = await activitiesService.getActivity(data.activityId);
    } catch (err) {
      throw badRequest("Activity not found or inactive");
    }

    // NO se valida acá la integridad del catálogo (validateActivityType).
    // Esa regla — 'class' exige service_provider_id y classes_per_month > 0,
    // 'machine' exige classes_per_month = 0 — describe cómo tiene que estar
    // configurada una ACTIVIDAD, y su lugar es el alta/edición de la actividad
    // y de sus horarios, donde activitiesService ya la aplica.
    //
    // Corriéndola acá, una actividad del catálogo mal configurada bloqueaba
    // suscribir clientes, que es una operación sin relación: en producción
    // ninguna de las 13 actividades tiene prestadora asignada, así que
    // rechazaba TODA suscripción a una actividad de tipo 'class'. Un problema
    // de configuración del catálogo tiene que verse y arreglarse en la pantalla
    // de Actividades, no aparecer como un error al dar de alta a una clienta.
    //
    // Para suscribir alcanza con que la actividad exista y esté activa, que es
    // lo que ya garantiza getActivity() arriba.

    // Validate monthlyAmount is positive
    const amount = typeof data.monthlyAmount === "string"
      ? parseFloat(data.monthlyAmount)
      : data.monthlyAmount;
    if (amount <= 0) {
      throw badRequest("monthlyAmount must be greater than 0");
    }

    // Create via repository with default status.
    // La base tiene un UNIQUE parcial (customer_id, activity_id) WHERE status='active'
    // — uq_training_subscriptions_customer_training_active. Sin este catch, intentar
    // suscribir dos veces al mismo cliente a la misma actividad escapa como 500 y el
    // front muestra el mensaje genérico, cuando en realidad es un error del usuario
    // perfectamente explicable.
    let created;
    try {
      created = await this.repository.create({
        activityId: data.activityId,
        customerId: data.customerId,
        subscriptionStartDate: data.subscriptionStartDate,
        subscriptionEndDate: data.subscriptionEndDate || null,
        status: "active",
        monthlyAmount: data.monthlyAmount,
        notes: data.notes || null,
      });
    } catch (err) {
      if (isUniqueViolation(err, "uq_training_subscriptions_customer_training_active")) {
        throw conflict(
          `${activity.name}: este cliente ya tiene una suscripción activa a esta actividad. ` +
            `Pausala o cancelala antes de crear una nueva.`
        );
      }
      throw err;
    }

    if (!created) {
      throw badRequest("Failed to create subscription");
    }

    return created;
  }

  /**
   * Get subscription by ID
   * @param id Subscription ID
   * @returns Subscription record
   * @throws notFound if subscription not found
   */
  async getSubscription(id: string) {
    const subscription = await this.repository.getById(id);
    if (!subscription) {
      throw notFound("Subscription");
    }
    return subscription;
  }

  /**
   * List subscriptions for a customer
   * @param customerId Customer ID
   * @returns Array of subscriptions
   */
  async listSubscriptions(customerId: string) {
    return this.repository.listByCustomerId(customerId);
  }

  /**
   * Update subscription with validation
   * @param id Subscription ID
   * @param data Partial subscription data to update
   * @returns Updated subscription record
   * @throws notFound if subscription not found
   * @throws badRequest if validation fails
   */
  async updateSubscription(
    id: string,
    data: {
      status?: "active" | "paused" | "cancelled";
      monthlyAmount?: number | string;
      subscriptionEndDate?: string | null;
      notes?: string | null;
    }
  ) {
    // Verify subscription exists
    const existing = await this.repository.getById(id);
    if (!existing) {
      throw notFound("Subscription");
    }

    // Validate dates if subscriptionEndDate is being updated
    if (data.subscriptionEndDate !== undefined && existing.subscriptionStartDate) {
      // Convert to YYYY-MM-DD string for validation
      const startDate = existing.subscriptionStartDate;

      // Handle both Date objects and strings
      let existingStartDateStr: string = '';
      if (typeof startDate === 'string') {
        existingStartDateStr = startDate;
      } else if (startDate && typeof startDate === 'object' && 'toISOString' in (startDate as any)) {
        existingStartDateStr = ((startDate as any).toISOString() as string).split('T')[0] || '';
      } else if (startDate) {
        existingStartDateStr = String(startDate);
      }

      if (existingStartDateStr) {
        this.validateDates(
          existingStartDateStr,
          data.subscriptionEndDate
        );
      }
    }

    // Validate monthlyAmount if being updated
    if (data.monthlyAmount !== undefined) {
      const amount = typeof data.monthlyAmount === "string"
        ? parseFloat(data.monthlyAmount)
        : data.monthlyAmount;
      if (amount <= 0) {
        throw badRequest("monthlyAmount must be greater than 0");
      }
    }

    // Validate status if being updated
    if (data.status !== undefined) {
      if (!["active", "paused", "cancelled"].includes(data.status)) {
        throw badRequest("status must be one of: active, paused, cancelled");
      }
    }

    // Update via repository
    const updated = await this.repository.update(id, data);
    if (!updated) {
      throw notFound("Subscription");
    }

    return updated;
  }

  /**
   * Get attendance summary for a subscription in a specific month
   * @param subscriptionId Subscription ID
   * @param year Year (e.g., 2026)
   * @param month Month (1-12)
   * @returns Object with month name, total classes, attended count, and detailed records
   * @throws notFound if subscription not found
   * @throws badRequest if date parameters are invalid
   */
  async getMonthlyAttendance(subscriptionId: string, year: number, month: number) {
    // Verify subscription exists
    const subscription = await this.repository.getById(subscriptionId);
    if (!subscription) {
      throw notFound("Subscription");
    }

    // Validate year and month
    if (year < 1900 || year > 2100) {
      throw badRequest("year must be between 1900 and 2100");
    }
    if (month < 1 || month > 12) {
      throw badRequest("month must be between 1 and 12");
    }

    // Get attendance records for the month
    const attendance = await this.repository.getAttendanceForMonth(
      subscriptionId,
      year,
      month
    );

    // Calculate statistics
    const attended = attendance.filter((a) => a.attended).length;
    const total = attendance.length;

    // Format month name using UTC to avoid timezone shifts
    const monthDate = new Date(Date.UTC(year, month - 1, 1));
    const monthName = monthDate.toLocaleDateString("es-AR", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

    return {
      subscriptionId,
      year,
      month,
      monthName,
      totalClasses: total,
      attendedCount: attended,
      records: attendance,
    };
  }

  /**
   * Roster de una clase: quiénes están agendados a (actividad, horario) y si ya
   * se les registró asistencia. Lo consume el modal de la Agenda.
   */
  async getClassRoster(activityId: string, startsAt: string): Promise<ClassRosterEntry[]> {
    const rows = await this.repository.getClassRoster(activityId, startsAt);
    return rows.map((row) => this.toRosterEntry(row));
  }

  private toRosterEntry(row: ClassRosterRow): ClassRosterEntry {
    const hasSubscription = Boolean(row.subscription_id);
    return {
      appointmentId: row.appointment_id,
      customerId: row.customer_id,
      customerName: row.customer_name ?? "(sin nombre)",
      subscriptionId: row.subscription_id,
      attended: row.attended === true,
      canMark: hasSubscription,
      reason: hasSubscription
        ? null
        : "Sin suscripción activa a esta actividad — no se puede registrar la asistencia",
    };
  }

  /**
   * Registra la asistencia de una clase, de a varios clientes a la vez.
   *
   * Reglas:
   * - No se puede marcar una clase que todavía no ocurrió (evita dar por
   *   asistida una clase futura y desvirtuar el historial).
   * - Solo se aceptan suscripciones que estén efectivamente agendadas a esa
   *   clase: el roster es la lista blanca. Así un id arbitrario no puede
   *   inflar el contador de asistencias de otro cliente.
   *
   * @param activityId Actividad de la clase
   * @param startsAt Timestamp de inicio de la clase (ISO)
   * @param entries Asistencia por suscripción
   * @returns El roster actualizado
   */
  async markClassAttendance(
    activityId: string,
    startsAt: string,
    entries: { subscriptionId: string; attended: boolean }[]
  ): Promise<ClassRosterEntry[]> {
    const start = new Date(startsAt);
    if (Number.isNaN(start.getTime())) {
      throw badRequest("startsAt must be a valid ISO timestamp");
    }
    if (start.getTime() > Date.now()) {
      throw badRequest(
        "No se puede registrar asistencia de una clase que todavía no ocurrió"
      );
    }

    const roster = await this.repository.getClassRoster(activityId, startsAt);
    if (roster.length === 0) {
      throw notFound("Class");
    }

    const markable = new Set(
      roster.map((r) => r.subscription_id).filter((id): id is string => Boolean(id))
    );
    const invalid = entries.filter((e) => !markable.has(e.subscriptionId));
    if (invalid.length > 0) {
      throw badRequest(
        `Estas suscripciones no están agendadas a esta clase: ${invalid
          .map((e) => e.subscriptionId)
          .join(", ")}`
      );
    }

    // class_date sale del propio turno, no del cliente: así el registro cae
    // siempre en el día real de la clase (en UTC, como el resto de la agenda).
    const classDate = roster[0]!.class_date;
    await this.repository.upsertAttendance(activityId, classDate, entries);

    return this.getClassRoster(activityId, startsAt);
  }

  /**
   * List subscriptions with current-month attendance for the admin panel
   * @param filters Optional filters: activityId, status, paidStatus
   * @returns Array of subscriptions enriched with attendance/payment info
   */
  async listSubscriptionsWithAttendance(filters: {
    activityId?: string;
    status?: "active" | "paused" | "cancelled";
    paidStatus?: "paid" | "pending" | "overdue";
  }): Promise<SubscriptionWithAttendance[]> {
    const rows = await this.repository.listWithAttendance(filters);
    return rows.map((row) => this.toSubscriptionWithAttendance(row));
  }

  /**
   * Get a single subscription enriched with current-month attendance/payment info,
   * used as the response shape for the admin PATCH endpoint.
   * @param id Subscription ID
   * @throws notFound if subscription not found
   */
  async getSubscriptionWithAttendance(id: string): Promise<SubscriptionWithAttendance> {
    const row = await this.repository.getByIdWithAttendance(id);
    if (!row) {
      throw notFound("Subscription");
    }
    return this.toSubscriptionWithAttendance(row);
  }

  /**
   * Update a subscription from the admin panel — status, notes, and/or payment date.
   *
   * Intentionally does NOT accept activityId, customerId, subscriptionStartDate,
   * subscriptionEndDate, or monthlyAmount: those fields are historical/billing
   * data and editing them would break past billing cycles and attendance history.
   *
   * - status/notes (if provided) update training_subscriptions directly.
   * - paidDate (if the key is present, including explicit null) upserts this
   *   month's subscription_billing_cycles row: null clears payment_date/is_paid,
   *   a date string sets them.
   *
   * @param id Subscription ID
   * @param data Partial admin-editable fields
   * @returns Updated SubscriptionWithAttendance
   * @throws notFound if subscription not found
   * @throws badRequest if no field is provided
   */
  async updateSubscriptionAdmin(
    id: string,
    data: {
      status?: "active" | "paused" | "cancelled";
      notes?: string | null;
      paidDate?: string | null;
    }
  ): Promise<SubscriptionWithAttendance> {
    // Verify subscription exists
    const existing = await this.repository.getById(id);
    if (!existing) {
      throw notFound("Subscription");
    }

    // Require at least one editable field. Defense in depth — the route also
    // enforces this via a Zod .refine on the request body.
    if (data.status === undefined && data.notes === undefined && data.paidDate === undefined) {
      throw badRequest("At least one of status, notes, or paidDate must be provided");
    }

    // Update status/notes on training_subscriptions when provided
    if (data.status !== undefined || data.notes !== undefined) {
      const updatePayload: {
        status?: "active" | "paused" | "cancelled";
        notes?: string | null;
      } = {};
      if (data.status !== undefined) updatePayload.status = data.status;
      if (data.notes !== undefined) updatePayload.notes = data.notes;
      await this.repository.update(id, updatePayload);
    }

    // paidDate key present (including explicit null) → upsert this month's billing cycle
    if (data.paidDate !== undefined) {
      await this.repository.upsertBillingCyclePaymentDate(id, data.paidDate);
    }

    return this.getSubscriptionWithAttendance(id);
  }

  /**
   * Map a raw SQL row (snake_case) to the SubscriptionWithAttendance shape,
   * computing classesRemainingThisMonth and paidStatus along the way.
   */
  private toSubscriptionWithAttendance(
    row: SubscriptionWithAttendanceRow
  ): SubscriptionWithAttendance {
    const activityType = row.activity_type as "class" | "machine";
    const classesPerMonth = Number(row.classes_per_month) || 0;
    const attendedThisMonth = Number(row.attended_this_month) || 0;
    const scheduledThisMonth = Number(row.scheduled_this_month) || 0;

    // El cupo lo consume el AGENDAMIENTO, no la asistencia: si reservó 5 de 8,
    // le quedan 3 para agendar aunque todavía no haya ido a ninguna. Es el
    // número que va a usar el control de acceso desde la web.
    // Las actividades de tipo máquina no tienen cupo mensual.
    const classesRemainingThisMonth =
      activityType === "machine"
        ? 0
        : Math.max(0, classesPerMonth - scheduledThisMonth);

    const paidDate = this.formatDateOnly(row.paid_date);

    return {
      id: row.id,
      customerId: row.customer_id,
      // full_name es nullable en CONTACTS y el JOIN es LEFT: nunca devolvemos
      // undefined al front, que lo pinta directo en la columna "Cliente".
      customerName: row.customer_name ?? "(sin nombre)",
      activityId: row.activity_id,
      activityName: row.activity_name,
      activityType,
      classesPerMonth,
      subscriptionStartDate: this.formatDateOnly(row.subscription_start_date) as string,
      subscriptionEndDate: this.formatDateOnly(row.subscription_end_date),
      monthlyAmount: Number(row.monthly_amount),
      status: row.status as "active" | "paused" | "cancelled",
      notes: row.notes,
      attendedThisMonth,
      scheduledThisMonth,
      classesRemainingThisMonth,
      paidDate,
      paidStatus: this.computePaidStatus(paidDate),
    };
  }

  /**
   * paidStatus logic:
   * - "paid": paidDate is set (subscription_billing_cycles.payment_date != null)
   * - "pending": no paidDate yet and today (UTC) is on/before the 10th
   * - "overdue": no paidDate and today (UTC) is past the 10th
   *
   * Kept in sync with the equivalent CASE expression used for SQL-side
   * filtering in TrainingSubscriptionsRepository.listWithAttendance.
   */
  private computePaidStatus(paidDate: string | null): "paid" | "pending" | "overdue" {
    if (paidDate) return "paid";
    // Día del mes en hora LOCAL del negocio: entre las 21:00 y las 24:00 ART,
    // getUTCDate() ya devuelve el día siguiente y el 10 se adelantaba tres horas.
    const currentDay = Number(todayLocal().split("-")[2]);
    return currentDay > 10 ? "overdue" : "pending";
  }

  /**
   * Normalize a Postgres date/timestamp value (which may arrive as a Date
   * object, a "T"-separated ISO string, or — as raw rows from db.execute()
   * do for `timestamp` columns like payment_date — a space-separated
   * "YYYY-MM-DD HH:mm:ss.ffffff" string) to a plain YYYY-MM-DD string.
   */
  private formatDateOnly(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
      // En hora LOCAL del negocio: un pago hecho a las 22:00 ART es un instante
      // UTC del día siguiente, y en UTC se mostraría con fecha de mañana.
      return utcToLocalDateString(value);
    }
    if (typeof value === "string") {
      const match = value.match(/^\d{4}-\d{2}-\d{2}/);
      return match ? match[0] : value;
    }
    return String(value);
  }
}

/**
 * Singleton instance of TrainingSubscriptionsService
 * Initialized with the trainingSubscriptionsRepository singleton
 * Usage: trainingSubscriptionsService.createSubscription(...) after app startup
 */
import { trainingSubscriptionsRepository } from "../repositories/trainingSubscriptionsRepository";

export const trainingSubscriptionsService = new TrainingSubscriptionsService(
  trainingSubscriptionsRepository
);
