import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { trainingSubscriptionsService } from "../services/trainingSubscriptionsService";
import type { AppBindings, Variables } from "../env";

const trainingSubscriptionsRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

/**
 * GET /api/training-subscriptions
 * List subscriptions for a customer (customerId required as query param)
 */
trainingSubscriptionsRouter.get("/training-subscriptions", async (c) => {
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
  zValidator(
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
trainingSubscriptionsRouter.get("/training-subscriptions/:id", async (c) => {
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
  zValidator(
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
  zValidator(
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
  zValidator(
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
trainingSubscriptionsRouter.get("/training-subscriptions/:id/attendance", async (c) => {
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
