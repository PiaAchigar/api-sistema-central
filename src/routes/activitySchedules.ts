import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { capacidadSchema, errorOrdenHoras, finPosteriorAInicio, finPosteriorAInicioOpcional, horaSchema } from "../lib/horario-schema";
import { activitySchedulesService } from "../services/activitySchedulesService";
import { requireAuth, requirePermission } from "../middleware/auth";
import type { AppBindings, Variables } from "../env";

const activitySchedulesRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// Horarios de actividades = catálogo, mismos permisos que las actividades.

// GET: por defecto solo activos; ?includeInactive=true trae también los pausados
// (la pantalla de Pausar/Reactivar los necesita para reactivar).
export const horarioListQuery = z.object({
  includeInactive: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

// Exportados para testearlos sin base (src/routes/activitySchedules.test.ts).
// En el POST las dos horas son obligatorias, así que el refine siempre aplica.
export const horarioBody = z
  .object({
    machineId: z.string().uuid().nullable().optional(),
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: horaSchema,
    endTime: horaSchema,
    validFrom: z.string().date().nullable().optional(),
    validUntil: z.string().date().nullable().optional(),
    capacity: capacidadSchema.optional(),
    serviceProviderId: z.string().uuid().nullable().optional(),
  })
  .refine(finPosteriorAInicio, errorOrdenHoras);

// En el PATCH todo es opcional: el orden de horas solo se valida si vienen las dos.
export const horarioPatchBody = z
  .object({
    machineId: z.string().uuid().nullable().optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    startTime: horaSchema.optional(),
    endTime: horaSchema.optional(),
    validFrom: z.string().date().nullable().optional(),
    validUntil: z.string().date().nullable().optional(),
    capacity: capacidadSchema.optional(),
    serviceProviderId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(finPosteriorAInicioOpcional, errorOrdenHoras);

/**
 * GET /api/activities/:activityId/schedules?includeInactive=true|false
 * List schedules for an activity (solo activos por defecto)
 */
activitySchedulesRouter.get(
  "/activities/:activityId/schedules",
  requireAuth,
  requirePermission("catalogo", "view"),
  zValidator("query", horarioListQuery),
  async (c) => {
    try {
      const activityId = c.req.param("activityId");
      const { includeInactive } = c.req.valid("query");
      const schedules = await activitySchedulesService.listSchedules(activityId, includeInactive);
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
  }
);

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
 *   capacity?: number | null (entero ≥ 1, o null = sin límite)
 *   serviceProviderId?: string | null (obligatoria en actividades 'class')
 * }
 */
activitySchedulesRouter.post(
  "/activities/:activityId/schedules",
  requireAuth,
  requirePermission("catalogo", "manage"),
  zValidator("json", horarioBody),
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
        capacity: body.capacity ?? null,
        serviceProviderId: body.serviceProviderId || null,
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
 *   capacity?: number | null (entero ≥ 1, o null = sin límite)
 *   serviceProviderId?: string | null (obligatoria en actividades 'class')
 *   isActive?: boolean (false = pausado; true = reactivado)
 * }
 */
activitySchedulesRouter.patch(
  "/activities/schedules/:scheduleId",
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", horarioPatchBody),
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
activitySchedulesRouter.delete("/activities/schedules/:scheduleId", requireAuth, requirePermission("catalogo", "manage"), async (c) => {
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
