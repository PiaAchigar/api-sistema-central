import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { activitySchedulesService } from "../services/activitySchedulesService";
import type { AppBindings, Variables } from "../env";

const activitySchedulesRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

/**
 * GET /api/activities/:activityId/schedules
 * List all active schedules for an activity
 */
activitySchedulesRouter.get("/activities/:activityId/schedules", async (c) => {
  try {
    const activityId = c.req.param("activityId");
    const schedules = await activitySchedulesService.listSchedules(activityId);
    return c.json({
      success: true,
      data: schedules,
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
 * POST /api/activities/:activityId/schedules
 * Create a new schedule for an activity
 *
 * Body:
 * {
 *   machineId?: string | null (required for 'machine' activities)
 *   dayOfWeek: number (0-6: Sunday to Saturday)
 *   startTime: string (HH:MM:SS)
 *   endTime: string (HH:MM:SS)
 *   validFrom?: string | null (ISO 8601 date)
 *   validUntil?: string | null (ISO 8601 date)
 * }
 */
activitySchedulesRouter.post(
  "/activities/:activityId/schedules",
  zValidator(
    "json",
    z.object({
      machineId: z.string().uuid().nullable().optional(),
      dayOfWeek: z.number().int().min(0).max(6),
      startTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Format must be HH:MM:SS"),
      endTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Format must be HH:MM:SS"),
      validFrom: z.string().date().nullable().optional(),
      validUntil: z.string().date().nullable().optional(),
    })
  ),
  async (c) => {
    try {
      const activityId = c.req.param("activityId");
      const body = c.req.valid("json");
      const created = await activitySchedulesService.createSchedule({
        activityId,
        machineId: body.machineId || null,
        dayOfWeek: body.dayOfWeek,
        startTime: body.startTime,
        endTime: body.endTime,
        validFrom: body.validFrom || null,
        validUntil: body.validUntil || null,
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
 * PATCH /api/activities/schedules/:scheduleId
 * Update a schedule
 *
 * Body (all optional):
 * {
 *   machineId?: string | null
 *   dayOfWeek?: number (0-6)
 *   startTime?: string (HH:MM:SS)
 *   endTime?: string (HH:MM:SS)
 *   validFrom?: string | null (ISO 8601 date)
 *   validUntil?: string | null (ISO 8601 date)
 * }
 */
activitySchedulesRouter.patch(
  "/activities/schedules/:scheduleId",
  zValidator(
    "json",
    z.object({
      machineId: z.string().uuid().nullable().optional(),
      dayOfWeek: z.number().int().min(0).max(6).optional(),
      startTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Format must be HH:MM:SS").optional(),
      endTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Format must be HH:MM:SS").optional(),
      validFrom: z.string().date().nullable().optional(),
      validUntil: z.string().date().nullable().optional(),
    })
  ),
  async (c) => {
    try {
      const scheduleId = c.req.param("scheduleId");
      const body = c.req.valid("json");
      const updated = await activitySchedulesService.updateSchedule(scheduleId, body);
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
 * DELETE /api/activities/schedules/:scheduleId
 * Soft-delete a schedule (set isActive to false)
 */
activitySchedulesRouter.delete("/activities/schedules/:scheduleId", async (c) => {
  try {
    const scheduleId = c.req.param("scheduleId");
    const deleted = await activitySchedulesService.deleteSchedule(scheduleId);
    return c.json({
      success: true,
      data: deleted,
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

export { activitySchedulesRouter };
