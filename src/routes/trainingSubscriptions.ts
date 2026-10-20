import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { zv } from "../lib/validator";
import { trainingSubscriptionsService } from "../services/trainingSubscriptionsService";
import { auth, requireAdmin, requireAuth, requirePermission } from "../middleware/auth";
import { createDb } from "../db/client";
import { resolveArcaConfig } from "../arca/factory";
import { badRequest, notFound } from "../lib/errors";
import { renovar } from "../services/anotar.service";
import { checkout } from "../services/checkout.service";
import {
  asegurarCicloDelMes,
  getCuotaDelMes,
  mensajeMontoSuperaDebe,
} from "../repositories/cuotas.repo";
import { activities, trainingSubscriptions } from "../db/schema";
import { eq } from "drizzle-orm";
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

const MES_SCHEMA = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "mes debe tener el formato YYYY-MM");

/**
 * GET /api/training-subscriptions/:id/cuota?mes=YYYY-MM
 * Cuánto cuesta, cuánto se pagó y cuánto se debe de un mes. No crea el ciclo.
 */
trainingSubscriptionsRouter.get(
  "/training-subscriptions/:id/cuota",
  auth,
  requireAuth,
  requirePermission("catalogo", "view"),
  zv("query", z.object({ mes: MES_SCHEMA })),
  async (c) => {
    const db = createDb(c.env);
    const { mes } = c.req.valid("query");
    return c.json(await getCuotaDelMes(db, c.req.param("id"), mes));
  }
);

/**
 * POST /api/training-subscriptions/:id/renovar  { mes }
 * Repite los horarios del mes anterior en `mes` y crea los turnos (ver `renovar`).
 */
trainingSubscriptionsRouter.post(
  "/training-subscriptions/:id/renovar",
  auth,
  requireAuth,
  requirePermission("agenda", "edit"),
  zv("json", z.object({ mes: MES_SCHEMA })),
  async (c) => {
    const db = createDb(c.env);
    const { mes } = c.req.valid("json");
    return c.json(await renovar(db, { subscriptionId: c.req.param("id"), mes }), 201);
  }
);

/**
 * POST /api/training-subscriptions/:id/cobrar
 * Cobra (total o parcial) la cuota de un mes reutilizando el MISMO `checkout()`
 * del mostrador y de las compras: pago, factura si lleva, línea de detalle y
 * movimiento de caja si es efectivo. El ítem es un concepto libre
 * "<actividad> — <mes> <año>": una cuota no es un service ni un product.
 *
 * Permiso de agenda/edit: es lo mismo que cobrar un turno desde la agenda.
 */
trainingSubscriptionsRouter.post(
  "/training-subscriptions/:id/cobrar",
  auth,
  requireAuth,
  requirePermission("agenda", "edit"),
  zv(
    "json",
    z.object({
      mes: MES_SCHEMA,
      amount: z.number().positive(),
      method: z.enum(["cash", "bank_transfer", "mercadopago", "debit_card", "credit_card"]),
      wantsInvoice: z.boolean(),
      issuerId: z.string().uuid().nullish(),
    })
  ),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const b = c.req.valid("json");

    // La plata se maneja en centavos: se redondea acá y todo lo de abajo (la
    // comparación contra el Debe y el cobro) usa el monto ya redondeado, así
    // 0.004 no se cuela como un pago de $0.
    const monto = Math.round(b.amount * 100) / 100;
    if (monto < 0.01) throw badRequest("El monto mínimo es $0,01");

    const [sub] = await db
      .select({
        status: trainingSubscriptions.status,
        customerId: trainingSubscriptions.customerId,
        activityName: activities.name,
      })
      .from(trainingSubscriptions)
      .leftJoin(activities, eq(activities.id, trainingSubscriptions.activityId))
      .where(eq(trainingSubscriptions.id, id))
      .limit(1);
    if (!sub) throw notFound("Subscription");
    if (sub.status === "cancelled") throw badRequest("La suscripción está cancelada");
    if (!sub.customerId) throw badRequest("La suscripción no tiene clienta");

    // Se valida ANTES de crear el ciclo para no dejar ciclos vacíos por un
    // cobro rechazado. checkout() lo vuelve a verificar bajo lock.
    const antes = await getCuotaDelMes(db, id, b.mes);
    if (monto > antes.debe) throw badRequest(mensajeMontoSuperaDebe(antes.debe));

    const arca = await resolveArcaConfig(db, c.env, b.issuerId ?? undefined);
    const ciclo = await asegurarCicloDelMes(db, id, b.mes);

    // Mes en letras en UTC: "2026-11" es el 1/11 UTC y en ART sería el 31/10.
    const [anio, mesNum] = b.mes.split("-").map(Number) as [number, number];
    const mesEnLetras = new Date(Date.UTC(anio, mesNum - 1, 1)).toLocaleDateString("es-AR", {
      month: "long",
      timeZone: "UTC",
    });

    const resultado = await checkout(db, arca, {
      customerId: sub.customerId,
      subscriptionBillingCycleId: ciclo,
      issuerId: b.issuerId ?? undefined,
      items: [
        {
          description: `${sub.activityName ?? "Actividad"} — ${mesEnLetras} ${anio}`,
          quantity: 1,
          unitPrice: monto,
        },
      ],
      payment: { method: b.method, amount: monto, wantsInvoice: b.wantsInvoice },
    });

    return c.json({ ...resultado, cuota: await getCuotaDelMes(db, id, b.mes) }, 201);
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
