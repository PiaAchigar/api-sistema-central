import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { zv } from "../lib/validator";
import { trainingSubscriptionsService } from "../services/trainingSubscriptionsService";
import { requireAdmin, requireAuth, requirePermission } from "../middleware/auth";
import type { AppBindings, Variables } from "../env";

const trainingSubscriptionsRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// Suscripciones = sección "catalogo", que es la que gatea la pestaña
// "Suscripciones" en front-dashboard → Administración (AdminLayout SUBNAV).
// Si acá pusiera "facturacion" habría roles que ven el tab y reciben 403, o al
// revés. Marcar un mes como pagado queda en requireAdmin, como dice el acta.
// `/class-attendance` es otra cosa: lo consume front-agenda, va con permisos de agenda.

/**
 * GET /api/training-subscriptions
 * List subscriptions for a customer (customerId required as query param)
 */
trainingSubscriptionsRouter.get("/training-subscriptions", requireAuth, requirePermission("catalogo", "view"), async (c) => {
  try {
    const customerId = c.req.query("customerId");
    if (!customerId) {
      return c.json(
        {
          success: false,
          error: "customerId query parameter is required",
        },
        400
      );
    }

    const subscriptions = await trainingSubscriptionsService.listSubscriptions(customerId);
    return c.json({
      success: true,
      data: subscriptions,
    });
  } catch (err) {
    if (err instanceof AppError) {
      return c.json(
        {
          success: false,
          error: err.message,
        },
        err.status
      );
    }
    throw err;
  }
});

/**
 * GET /api/class-attendance?activityId=&startsAt=
 * Roster de una clase: clientes agendados a (actividad, horario) con su estado
 * de asistencia. Lo consume el modal de asistencias de la Agenda.
 *
 * Una actividad grupal son N appointments distintos con el mismo activity_id y
 * el mismo appointment_start, por eso la clase se identifica por ese par y no
 * por un appointment id.
 */
trainingSubscriptionsRouter.get(
  "/class-attendance",
  requireAuth,
  requirePermission("agenda", "view"),
  zv(
    "query",
    z.object({
      activityId: z.string().uuid("activityId must be a valid UUID"),
      startsAt: z.string().datetime({ offset: true, message: "startsAt must be an ISO timestamp" }),
    })
  ),
  async (c) => {
    try {
      const { activityId, startsAt } = c.req.valid("query");
      const roster = await trainingSubscriptionsService.getClassRoster(activityId, startsAt);
      return c.json({ success: true, data: roster });
    } catch (err) {
      if (err instanceof AppError) {
        return c.json({ success: false, error: err.message }, err.status);
      }
      throw err;
    }
  }
);

/**
 * POST /api/class-attendance
 * Registra la asistencia de una clase para varios clientes de una sola vez.
 *
 * Body: { activityId, startsAt, entries: [{ subscriptionId, attended }] }
 * Response: { success: true, data: <roster actualizado> }
 */
trainingSubscriptionsRouter.post(
  "/class-attendance",
  requireAuth,
  requirePermission("agenda", "edit"),
  zv(
    "json",
    z.object({
      activityId: z.string().uuid("activityId must be a valid UUID"),
      startsAt: z.string().datetime({ offset: true, message: "startsAt must be an ISO timestamp" }),
      entries: z
        .array(
          z.object({
            subscriptionId: z.string().uuid("subscriptionId must be a valid UUID"),
            attended: z.boolean(),
          })
        )
        .min(1, "entries must contain at least one row"),
    })
  ),
  async (c) => {
    try {
      const { activityId, startsAt, entries } = c.req.valid("json");
      const roster = await trainingSubscriptionsService.markClassAttendance(
        activityId,
        startsAt,
        entries
      );
      return c.json({ success: true, data: roster });
    } catch (err) {
      if (err instanceof AppError) {
        return c.json({ success: false, error: err.message }, err.status);
      }
      throw err;
    }
  }
);

/**
 * GET /api/training-subscriptions/admin/list
 * List subscriptions with current-month attendance for the admin panel
 *
 * Query params (all optional):
 * - activityId: string (UUID) — filter by activity
 * - status: "active" | "paused" | "cancelled" — filter by subscription status
 * - paidStatus: "paid" | "pending" | "overdue" — filter by current-month payment status
 */
trainingSubscriptionsRouter.get(
  "/training-subscriptions/admin/list",
  requireAuth,
  requirePermission("catalogo", "view"),
  zv(
    "query",
    z.object({
      activityId: z.string().uuid("activityId must be a valid UUID").optional(),
      status: z.enum(["active", "paused", "cancelled"]).optional(),
      paidStatus: z.enum(["paid", "pending", "overdue"]).optional(),
    })
  ),
  async (c) => {
    try {
      const filters = c.req.valid("query");
      const subscriptions = await trainingSubscriptionsService.listSubscriptionsWithAttendance(
        filters
      );
      return c.json({
        success: true,
        data: subscriptions,
      });
    } catch (err) {
      if (err instanceof AppError) {
        return c.json(
          {
            success: false,
            error: err.message,
          },
          err.status
        );
      }
      throw err;
    }
  }
);

/**
 * GET /api/training-subscriptions/:id
 * Get a single subscription by ID
 */
trainingSubscriptionsRouter.get("/training-subscriptions/:id", requireAuth, requirePermission("catalogo", "view"), async (c) => {
  try {
    const id = c.req.param("id");
    const subscription = await trainingSubscriptionsService.getSubscription(id);
    return c.json({
      success: true,
      data: subscription,
    });
  } catch (err) {
    if (err instanceof AppError) {
      return c.json(
        {
          success: false,
          error: err.message,
        },
        err.status
      );
    }
    throw err;
  }
});

/**
 * POST /api/training-subscriptions
 * Create a new subscription
 *
 * Body:
 * {
 *   activityId: string (UUID)
 *   customerId: string (UUID)
 *   subscriptionStartDate: string (YYYY-MM-DD)
 *   subscriptionEndDate?: string (YYYY-MM-DD) | null
 *   monthlyAmount: number | string (must be > 0)
 *   notes?: string | null
 * }
 */
trainingSubscriptionsRouter.post(
  "/training-subscriptions",
  requireAuth,
  requirePermission("catalogo", "edit"),
  zv(
    "json",
    z.object({
      activityId: z.string().uuid("activityId must be a valid UUID"),
      customerId: z.string().uuid("customerId must be a valid UUID"),
      subscriptionStartDate: z.string().regex(
        /^\d{4}-\d{2}-\d{2}$/,
        "subscriptionStartDate must be in YYYY-MM-DD format"
      ),
      subscriptionEndDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "subscriptionEndDate must be in YYYY-MM-DD format")
        .nullable()
        .optional(),
      monthlyAmount: z.union([z.number().positive(), z.string()]),
      notes: z.string().nullable().optional(),
    })
  ),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const created = await trainingSubscriptionsService.createSubscription({
        activityId: body.activityId,
        customerId: body.customerId,
        subscriptionStartDate: body.subscriptionStartDate,
        subscriptionEndDate: body.subscriptionEndDate || null,
        monthlyAmount: body.monthlyAmount,
        notes: body.notes || null,
      });
      return c.json(
        {
          success: true,
          data: created,
        },
        201
      );
    } catch (err) {
      if (err instanceof AppError) {
        return c.json(
          {
            success: false,
            error: err.message,
          },
          err.status
        );
      }
      throw err;
    }
  }
);

/**
 * PATCH /api/training-subscriptions/:id
 * Update a subscription
 *
 * Body (all optional):
 * {
 *   status?: "active" | "paused" | "cancelled"
 *   monthlyAmount?: number | string
 *   subscriptionEndDate?: string | null
 *   notes?: string | null
 * }
 */
trainingSubscriptionsRouter.patch(
  "/training-subscriptions/:id",
  requireAuth,
  requirePermission("catalogo", "edit"),
  zv(
    "json",
    z.object({
      status: z.enum(["active", "paused", "cancelled"]).optional(),
      monthlyAmount: z.union([z.number().positive(), z.string()]).optional(),
      subscriptionEndDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "subscriptionEndDate must be in YYYY-MM-DD format")
        .nullable()
        .optional(),
      notes: z.string().nullable().optional(),
    })
  ),
  async (c) => {
    try {
      const id = c.req.param("id");
      const body = c.req.valid("json");
      const updated = await trainingSubscriptionsService.updateSubscription(id, body);
      return c.json({
        success: true,
        data: updated,
      });
    } catch (err) {
      if (err instanceof AppError) {
        return c.json(
          {
            success: false,
            error: err.message,
          },
          err.status
        );
      }
      throw err;
    }
  }
);

/**
 * PATCH /api/training-subscriptions/:id/admin
 * Edit a subscription's status, notes, and/or payment date from the admin panel.
 *
 * Body (at least one field required):
 * {
 *   status?: "active" | "paused" | "cancelled";
 *   notes?: string | null;
 *   paidDate?: string | null (YYYY-MM-DD) — upserts this month's subscription_billing_cycles row
 * }
 *
 * Does NOT allow editing activityId, customerId, subscriptionStartDate,
 * subscriptionEndDate, or monthlyAmount — those are historical/billing data.
 *
 * Response: { success: true, data: SubscriptionWithAttendance }
 */
trainingSubscriptionsRouter.patch(
  "/training-subscriptions/:id/admin",
  requireAuth,
  requireAdmin,
  zv(
    "json",
    z
      .object({
        status: z.enum(["active", "paused", "cancelled"]).optional(),
        notes: z.string().nullable().optional(),
        paidDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "paidDate must be in YYYY-MM-DD format")
          .nullable()
          .optional(),
      })
      .refine(
        (data) =>
          data.status !== undefined || data.notes !== undefined || data.paidDate !== undefined,
        { message: "At least one of status, notes, or paidDate must be provided" }
      )
  ),
  async (c) => {
    try {
      const id = c.req.param("id");
      const body = c.req.valid("json");
      const updated = await trainingSubscriptionsService.updateSubscriptionAdmin(id, body);
      return c.json({
        success: true,
        data: updated,
      });
    } catch (err) {
      if (err instanceof AppError) {
        return c.json(
          {
            success: false,
            error: err.message,
          },
          err.status
        );
      }
      throw err;
    }
  }
);

/**
 * GET /api/training-subscriptions/:id/attendance
 * Get monthly attendance for a subscription
 *
 * Query params:
 * - year: number (optional, defaults to current year)
 * - month: number (optional, defaults to current month)
 */
trainingSubscriptionsRouter.get("/training-subscriptions/:id/attendance", requireAuth, requirePermission("catalogo", "view"), async (c) => {
  try {
    const id = c.req.param("id");
    const yearParam = c.req.query("year");
    const monthParam = c.req.query("month");

    // Determine year and month (default to current)
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth() + 1;

    if (yearParam) {
      year = parseInt(yearParam, 10);
      if (isNaN(year)) {
        return c.json(
          {
            success: false,
            error: "year must be a valid integer",
          },
          400
        );
      }
    }

    if (monthParam) {
      month = parseInt(monthParam, 10);
      if (isNaN(month)) {
        return c.json(
          {
            success: false,
            error: "month must be a valid integer",
          },
          400
        );
      }
    }

    const attendance = await trainingSubscriptionsService.getMonthlyAttendance(
      id,
      year,
      month
    );
    return c.json({
      success: true,
      data: attendance,
    });
  } catch (err) {
    if (err instanceof AppError) {
      return c.json(
        {
          success: false,
          error: err.message,
        },
        err.status
      );
    }
    throw err;
  }
});

export { trainingSubscriptionsRouter };
