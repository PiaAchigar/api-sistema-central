import { Hono } from "hono";
import { z } from "zod";
import { zv } from "../lib/validator";
import { AppError } from "../lib/errors";
import { activitiesService } from "../services/activitiesService";
import { requireAdmin, requireAuth, requirePermission } from "../middleware/auth";
import type { AppBindings, Variables } from "../env";

const activitiesRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// Las actividades son catálogo, igual que los servicios: mismos permisos que
// `/api/agenda/services` (sección "catalogo" de reglas_negocio §1.7). El único
// consumidor es front-dashboard → Administración, que ya manda el token.
// A diferencia de los servicios, acá NADA es público: el sitio web no lee
// actividades, así que hasta el listado pide sesión.

/**
 * GET /api/activities
 * List all active activities
 */
activitiesRouter.get("/activities", requireAuth, requirePermission("catalogo", "view"), async (c) => {
  try {
    // ?includeInactive=true trae también las archivadas, para que la pantalla
    // de Actividades pueda mostrarlas y restaurarlas (mismo patrón que
    // /api/agenda/services).
    const includeInactive = c.req.query("includeInactive") === "true";
    const activities = await activitiesService.listActivities(!includeInactive);
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
activitiesRouter.get("/activities/:id", requireAuth, requirePermission("catalogo", "view"), async (c) => {
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
  requireAuth,
  requirePermission("catalogo", "manage"),
  zv(
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
  requireAuth,
  requirePermission("catalogo", "edit"),
  zv(
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
activitiesRouter.delete("/activities/:id", requireAuth, requirePermission("catalogo", "manage"), async (c) => {
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

/**
 * POST /api/activities/:id/restore
 * Restore an archived activity (set isActive back to true)
 */
activitiesRouter.post("/activities/:id/restore", requireAuth, requirePermission("catalogo", "manage"), async (c) => {
  try {
    const id = c.req.param("id");
    const restored = await activitiesService.restoreActivity(id);
    return c.json({
      success: true,
      data: restored,
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
 * DELETE /api/activities/:id/hard
 * Permanently delete an activity from the database (irreversible)
 * WARNING: This cannot be undone
 *
 * Solo admin, igual que el hard-delete de servicios: es irreversible.
 */
activitiesRouter.delete("/activities/:id/hard", requireAuth, requireAdmin, async (c) => {
  try {
    const id = c.req.param("id");
    await activitiesService.hardDeleteActivity(id);
    return c.json({
      success: true,
      data: { id },
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
