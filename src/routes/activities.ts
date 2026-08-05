import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { activitiesService } from "../services/activitiesService";
import type { AppBindings, Variables } from "../env";

const activitiesRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

/**
 * GET /api/activities
 * List all active activities
 */
activitiesRouter.get("/activities", async (c) => {
  try {
    const activities = await activitiesService.listActivities(true);
    return c.json({
      success: true,
      data: activities,
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
 * GET /api/activities/:id
 * Get a single activity by ID
 */
activitiesRouter.get("/activities/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const activity = await activitiesService.getActivity(id);
    return c.json({
      success: true,
      data: activity,
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
 * POST /api/activities
 * Create a new activity
 *
 * Body:
 * {
 *   name: string
 *   description?: string | null
 *   activityType: "class" | "machine"
 *   serviceProviderId?: string | null (required for 'class')
 *   classesPerMonth: number (> 0 for 'class', = 0 for 'machine')
 *   monthlyBasePrice: number | string
 * }
 */
activitiesRouter.post(
  "/activities",
  zValidator(
    "json",
    z.object({
      name: z.string().min(1, "Activity name is required"),
      description: z.string().nullable().optional(),
      activityType: z.enum(["class", "machine"]),
      serviceProviderId: z.string().uuid().nullable().optional(),
      classesPerMonth: z.number().int().min(0),
      monthlyBasePrice: z.union([z.number(), z.string()]),
    }).refine(
      (data) => {
        if (data.activityType === "class") {
          return data.serviceProviderId != null && data.classesPerMonth > 0;
        }
        if (data.activityType === "machine") {
          return data.classesPerMonth === 0;
        }
        return true;
      },
      {
        message: "Invalid activity type constraints: class requires service_provider_id and classes_per_month > 0; machine requires classes_per_month = 0",
        path: ["activityType"],
      }
    )
  ),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const created = await activitiesService.createActivity({
        name: body.name,
        description: body.description || null,
        activityType: body.activityType,
        serviceProviderId: body.serviceProviderId || null,
        classesPerMonth: body.classesPerMonth,
        monthlyBasePrice: body.monthlyBasePrice,
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
 * PATCH /api/activities/:id
 * Update an activity
 *
 * Body (all optional):
 * {
 *   name?: string
 *   description?: string | null
 *   activityType?: "class" | "machine"
 *   serviceProviderId?: string | null
 *   classesPerMonth?: number
 *   monthlyBasePrice?: number | string
 * }
 */
activitiesRouter.patch(
  "/activities/:id",
  zValidator(
    "json",
    z.object({
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      activityType: z.enum(["class", "machine"]).optional(),
      serviceProviderId: z.string().uuid().nullable().optional(),
      classesPerMonth: z.number().int().min(0).optional(),
      monthlyBasePrice: z.union([z.number(), z.string()]).optional(),
    })
  ),
  async (c) => {
    try {
      const id = c.req.param("id");
      const body = c.req.valid("json");
      const updated = await activitiesService.updateActivity(id, body);
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
 * DELETE /api/activities/:id
 * Soft-delete an activity (set isActive to false)
 */
activitiesRouter.delete("/activities/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const deleted = await activitiesService.deleteActivity(id);
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

export { activitiesRouter };
