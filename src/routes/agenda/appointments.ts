import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { resolveArcaConfig } from "../../arca/factory";
import { createDb } from "../../db/client";
import {
  computeProviderEarning,
  createAppointment,
  listAppointmentsByDays,
  rescheduleAppointment,
  updateAppointmentStatus,
} from "../../services/appointments.service";
import { hermanosDelCombo, queSeDescuenta } from "../../repositories/consumo.repo";
import { listReschedules } from "../../repositories/appointment-reschedule.repo";
import { getAppointmentById, getAppointmentDetail } from "../../repositories/appointments.repo";
import { getDeudasDeCompras } from "../../repositories/compras.repo";
import { getDealByAppointmentId } from "../../repositories/deals.repo";
import { requireAuth } from "../../middleware/auth";
import { notFound } from "../../lib/errors";
import type { AppBindings, Variables } from "../../env";

const appointmentsRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Tope del rango: seis semanas, lo más que muestra la agenda de una vez. */
const MAX_DIAS_RANGO = 42;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * Exportado para validarlo con `.safeParse()` directo (ver `comboPendientesQuery`).
 * Un día (`date`) o un rango inclusive (`from` + `to`), nunca los dos.
 */
export const listQuery = z
  .object({
    date: FECHA.optional(),
    from: FECHA.optional(),
    to: FECHA.optional(),
    providerId: z.string().uuid().optional(),
    status: z.enum(["scheduled", "completed", "cancelled", "no_show"]).optional(),
  })
  .superRefine((q, ctx) => {
    const error = (message: string) => ctx.addIssue({ code: "custom", message });
    const hayRango = q.from !== undefined || q.to !== undefined;
    if (q.date && hayRango) return error("Pasá `date` o `from`/`to`, no las dos");
    if (!q.date && !hayRango) return error("Falta `date` o `from`/`to`");
    if (!q.date) {
      if (!q.from || !q.to) return error("El rango necesita `from` y `to`");
      if (q.from > q.to) return error("`from` no puede ser posterior a `to`");
      const dias = (Date.parse(q.to) - Date.parse(q.from)) / MS_POR_DIA + 1;
      if (dias > MAX_DIAS_RANGO) return error(`El rango no puede pasar de ${MAX_DIAS_RANGO} días`);
    }
  });

appointmentsRouter.get("/", requireAuth, zValidator("query", listQuery), async (c) => {
  const db = createDb(c.env);
  const { date, from, to, ...filters } = c.req.valid("query");
  const rows = await listAppointmentsByDays(db, date ?? from!, date ?? to!, filters);
  // Una sola consulta para la deuda de todas las compras del rango.
  const deudas = await getDeudasDeCompras(
    db,
    [...new Set(rows.map((r) => r.customerPurchaseId).filter((id): id is string => !!id))],
  );
  return c.json(
    rows.map((r) => ({
      ...r,
      servicePrice: r.servicePrice != null ? Number(r.servicePrice) : null,
      deudaDeLaCompra: r.customerPurchaseId ? (deudas.get(r.customerPurchaseId) ?? null) : null,
    })),
  );
});

/**
 * Qué tiene la clienta a favor para este servicio, y qué se descontaría.
 *
 * La pantalla de turno nuevo la consulta al elegir clienta y servicio:
 *
 *   `ninguna`      no tiene nada: el turno se cobra aparte
 *   `automatica`   una sola compra con servicios comprados libres → se descuenta sola
 *   `elige_laura`  varias → la lista, ordenada por lo que vence antes
 *
 * ⚠️ Va registrada ANTES de `/:id`: Hono resuelve por orden, y al revés esta
 * URL entraría por el comodín con id="consumible" y devolvería un 404. Mismo
 * caso que `/admin/tarifarios` en las rutas de combos.
 */
appointmentsRouter.get(
  "/consumible",
  requireAuth,
  zValidator(
    "query",
    z.object({
      customerId: z.string().uuid({ message: "Falta la clienta" }),
      serviceId: z.string().uuid({ message: "Falta el servicio" }),
    }),
  ),
  async (c) => {
    const db = createDb(c.env);
    const { customerId, serviceId } = c.req.valid("query");
    return c.json(await queSeDescuenta(db, customerId, serviceId, new Date()));
  },
);

/**
 * Exportado para que el test la valide con `.safeParse()` directo — mismo
 * motivo que `createBody` más abajo: un `.request()` contra este router
 * pasa por `requireAuth` primero (sin `auth` montado encima, `userId` nunca
 * se setea y el 401 llega antes que cualquier validación), así que probar
 * la forma del query string por HTTP exigiría montar la app entera con un
 * token falso. Probar el schema solo es más simple y prueba lo mismo.
 */
export const comboPendientesQuery = z.object({
  purchaseServiceId: z.string().uuid({ message: "Falta el servicio comprado" }),
});

/**
 * Lo que falta agendar del mismo combo "se hacen juntos" (V3c), una vez
 * confirmado el primer servicio.
 *
 * ⚠️ Va registrada ANTES de `/:id`, mismo motivo que `/consumible` (ver el
 * comentario ahí arriba).
 */
appointmentsRouter.get(
  "/combo-pendientes",
  requireAuth,
  zValidator("query", comboPendientesQuery),
  async (c) => {
    const db = createDb(c.env);
    const { purchaseServiceId } = c.req.valid("query");
    const pendientes = await hermanosDelCombo(db, purchaseServiceId);
    return c.json({ pendientes });
  },
);

appointmentsRouter.get("/:id", requireAuth, async (c) => {
  const db = createDb(c.env);
  const appt = await getAppointmentDetail(db, c.req.param("id"));
  if (!appt) throw notFound("Appointment");

  // Si todavía no se completó (y por lo tanto no hay comisión congelada), la
  // calculamos en vivo con el acuerdo actual solo para mostrarla — no se
  // persiste acá (eso lo hace el checkout al cobrar de verdad).
  let providerPaymentType = appt.providerPaymentType;
  let providerRate = appt.providerRate;
  let providerEarning = appt.providerEarning;
  let providerEarningIsPreview = false;
  if (providerEarning == null && appt.providerId && appt.serviceId) {
    const raw = await getAppointmentById(db, appt.id);
    const preview = raw ? await computeProviderEarning(db, raw) : {};
    if ("providerEarning" in preview) {
      providerPaymentType = preview.providerPaymentType ?? null;
      providerRate = preview.providerRate ?? null;
      providerEarning = preview.providerEarning ?? null;
      providerEarningIsPreview = true;
    }
  }

  // Seña a favor del cliente (si el turno se reservó con seña pagada)
  const deal = await getDealByAppointmentId(db, appt.id);
  const depositPaid =
    deal?.seniaPaid && deal.seniaAmount != null ? Number(deal.seniaAmount) : 0;

  return c.json({
    ...appt,
    servicePrice: appt.servicePrice != null ? Number(appt.servicePrice) : null,
    providerPaymentType,
    providerRate: providerRate != null ? Number(providerRate) : null,
    providerEarning: providerEarning != null ? Number(providerEarning) : null,
    providerEarningIsPreview,
    depositPaid,
  });
});

export const createBody = z.object({
  customerId: z.string().uuid(),
  serviceId: z.string().uuid(),
  providerId: z.string().uuid(),
  machineId: z.string().uuid().optional(),
  start: z.string().datetime({ offset: true }),
  priceMode: z.enum(["list", "cash"]).optional(),
  notes: z.string().max(1000).optional(),
  status: z.enum(["scheduled", "reserved"]).optional(),
  // Hasta 24 h: una reserva de depilación se guarda un día entero mientras la
  // clienta consigue la plata. El tope viejo era 480 (8 h).
  expiryMinutes: z.number().int().min(5).max(1440).optional(),
  /** El servicio comprado (sin fecha todavía) que este turno descuenta (V3b).
   *  Sin esto, no descuenta nada y el turno se cobra aparte, que es el caso
   *  más común. */
  customerPurchaseServiceId: z.string().uuid().optional(),
  /** Las zonas elegidas para un turno de depilación (1.56.0). Ver
   *  `CreateAppointmentInput.zonas`. */
  zonas: z.array(z.string().uuid()).optional(),
  /** El selector de sexo del turno (1.56.0, §3.3a). Ver
   *  `CreateAppointmentInput.sexo`: sin esto el servidor recalculaba la
   *  duración con el sexo de la ficha aunque la pantalla mostrara el otro. */
  sexo: z.enum(["mujer", "hombre"]).optional(),
  deposit: z
    .object({
      amount: z.number().positive(),
      /** "credit" paga con el saldo a favor del cliente (no entra plata nueva). */
      method: z.enum(["cash", "bank_transfer", "mercadopago", "credit"]),
      /** Facturador de la seña. Si no viene, el marcado por defecto. */
      issuerId: z.string().uuid().optional(),
    })
    .optional(),
});

appointmentsRouter.post("/", zValidator("json", createBody), async (c) => {
  const db = createDb(c.env);
  const input = c.req.valid("json");
  const arca = await resolveArcaConfig(db, c.env, input.deposit?.issuerId);
  const appointment = await createAppointment(db, input, arca);
  return c.json(appointment, 201);
});

const patchBody = z.object({
  status: z.enum(["reserved", "scheduled", "completed", "cancelled", "no_show"]).optional(),
  notes: z.string().max(1000).optional(),
});

appointmentsRouter.patch("/:id", requireAuth, zValidator("json", patchBody), async (c) => {
  const db = createDb(c.env);
  const updated = await updateAppointmentStatus(db, c.req.param("id"), c.req.valid("json"));
  return c.json(updated);
});

export const rescheduleBody = z.object({
  newStart: z.string().datetime({ offset: true }),
  // Opcional: pasar el turno a OTRA proveedora que ofrezca el mismo servicio.
  // Ausente = la misma de siempre (el reagendado de sólo fecha/hora).
  providerId: z.string().uuid().optional(),
  // Opcional: quien mueve el turno puede escribir por qué. Queda en el
  // historial, que es lo único que después explica un cambio de fecha.
  reason: z.string().max(500).optional(),
});

appointmentsRouter.patch("/:id/reschedule", requireAuth, zValidator("json", rescheduleBody), async (c) => {
  const db      = createDb(c.env);
  const body    = c.req.valid("json");
  const updated = await rescheduleAppointment(
    db,
    c.req.param("id"),
    body.newStart,
    { userId: c.get("userId"), reason: body.reason ?? null },
    body.providerId,
  );
  return c.json(updated);
});

/** Historial de movimientos del turno, del más nuevo al más viejo. */
appointmentsRouter.get("/:id/reschedules", requireAuth, async (c) => {
  const db = createDb(c.env);
  return c.json(await listReschedules(db, c.req.param("id")));
});

export { appointmentsRouter };
