import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { badRequest, notFound } from "../../lib/errors";
import { auth, requireAdmin, requireAuth, requirePermission } from "../../middleware/auth";
import {
  createProvider,
  getActiveAgreementsForService,
  getProviderById,
  getProviderDeleteImpact,
  hardDeleteProvider,
  listActiveProviders,
  listAgreementRowsForService,
  listProvidersAdmin,
  setProviderStatus,
  setServiceAgreements,
  updateProvider,
} from "../../repositories/providers.repo";
import { getProviderSchedules } from "../../services/availability.service";
import {
  createService,
  getCategoriesForServices,
  getMachinesForService,
  getPrimaryMachinesForServices,
  getServiceById,
  getServiceDeleteImpact,
  hardDeleteService,
  listServices,
  listServicesForProvider,
  setServiceActive,
  setServiceCategories,
  updateService,
} from "../../repositories/services.repo";
import { setServicePrimaryMachine } from "../../repositories/machines.repo";
import {
  createMpAccount,
  deleteMpAccount,
  listMpAccountsByProvider,
  updateMpAccount,
} from "../../repositories/mercadopago.repo";
import { listAppointmentsByRange } from "../../repositories/appointments.repo";
import {
  addException,
  addSaturdaySchedule,
  deleteException,
  deleteSaturdaySchedule,
  listExceptions,
  listSaturdaySchedule,
  listWeeklyAvailability,
  listWeeklyAvailabilityForAllProviders,
  setWeeklyAvailability,
} from "../../repositories/provider-availability.repo";
import { localDayRangeUtc, todayLocal } from "../../lib/time";
import { isForeignKeyViolation } from "../../lib/db-errors";
import type { AppBindings, Variables } from "../../env";

/** Roles con permiso de editar catálogo (nivel E de la matriz de reglas_negocio). */
const STAFF = ["admin", "manager", "operator"] as const;

const services = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

const listQuery = z.object({
  categoryId: z.string().uuid().optional(),
  q: z.string().max(100).optional(),
  featured: z.string().optional().transform((v) => v === "true"),
  includeInactive: z.string().optional(),
});

// `auth` no bloquea: permite que un usuario staff sume los archivados con
// ?includeInactive=true sin afectar el GET público de agenda/web.
services.get("/", auth, zValidator("query", listQuery), async (c) => {
  const db = createDb(c.env);
  const filters = c.req.valid("query");
  const canSeeInactive = (STAFF as readonly string[]).includes(c.get("userRole") ?? "");
  const rows = await listServices(db, {
    categoryId: filters.categoryId,
    q: filters.q,
    featured: filters.featured,
    includeInactive: canSeeInactive && filters.includeInactive === "true",
  });

  const serviceIds = rows.map((r) => r.id);
  const [categoryRows, primaryMachineRows] = await Promise.all([
    getCategoriesForServices(db, serviceIds),
    getPrimaryMachinesForServices(db, serviceIds),
  ]);

  const categoriesByService = new Map<string, { id: string; name: string | null }[]>();
  for (const cr of categoryRows) {
    if (!cr.serviceId) continue;
    const list = categoriesByService.get(cr.serviceId) ?? [];
    list.push({ id: cr.categoryId, name: cr.categoryName });
    categoriesByService.set(cr.serviceId, list);
  }

  const machineByService = new Map<string, { id: string; name: string | null }>();
  for (const m of primaryMachineRows) {
    if (m.serviceId) machineByService.set(m.serviceId, { id: m.machineId, name: m.machineName });
  }

  return c.json(
    rows.map((r) => ({
      ...r,
      unitPriceList: r.unitPriceList != null ? Number(r.unitPriceList) : null,
      unitPriceCash: r.unitPriceCash != null ? Number(r.unitPriceCash) : null,
      categories: categoriesByService.get(r.id) ?? [],
      primaryMachine: machineByService.get(r.id) ?? null,
    })),
  );
});

services.get("/:id", async (c) => {
  const db = createDb(c.env);
  const id = c.req.param("id");
  const svc = await getServiceById(db, id);
  if (!svc) throw notFound("Service");

  const [categoryRows, machines, providers] = await Promise.all([
    getCategoriesForServices(db, [id]),
    getMachinesForService(db, id),
    getActiveAgreementsForService(db, id, todayLocal()),
  ]);

  return c.json({
    ...svc,
    unitPriceList: svc.unitPriceList != null ? Number(svc.unitPriceList) : null,
    unitPriceCash: svc.unitPriceCash != null ? Number(svc.unitPriceCash) : null,
    categories: categoryRows.map((r) => ({ id: r.categoryId, name: r.categoryName })),
    machines,
    providers: providers.map((p) => ({ id: p.providerId, name: p.providerName })),
  });
});

// Campos editables del servicio (incluye los web settings que ya usaba el dashboard).
const serviceBody = z.object({
  name: z.string().min(1).max(255).optional(),
  // 2000, no 255: la columna en la base es `text` (sin límite) y el tope de 255
  // era una restricción arbitraria del API que no coincidía con ella. Cinco
  // servicios reales ya tenían descripciones de 262 a 303 caracteres — cargados
  // por fuera del dashboard — y eso los volvía imposibles de guardar desde el
  // modal: el PATCH fallaba con 400 antes de llegar a las categorías, y el
  // error se veía en pantalla como "[object Object]".
  description: z.string().max(2000).nullish(),
  code: z.string().max(50).nullish(),
  unitPriceList: z.number().nonnegative().nullish(),
  unitPriceCash: z.number().nonnegative().nullish(),
  unitType: z.string().max(50).nullish(),
  taxCategory: z.string().max(50).nullish(),
  requiresOperator: z.boolean().nullish(),
  requiresMachine: z.boolean().nullish(),
  estimatedDurationMinutes: z.number().int().nonnegative().nullish(),
  isVisible: z.boolean().nullish(),
  isFeatured: z.boolean().optional(),
  webSortOrder: z.number().int().min(0).nullish(),
  /** Máquina principal del servicio (gestiona service_machine). null = quitar. */
  machineId: z.string().uuid().nullish(),
  /** Contenido RAG: beneficios, contraindicaciones e instrucciones especiales */
  benefits: z.string().max(2000).nullish(),
  contraindications: z.string().max(2000).nullish(),
  specialAttentionNotes: z.string().max(2000).nullish(),
});

/** Serializa decimales (string en DB) a number para el cliente. */
function serializeService<T extends { unitPriceList?: unknown; unitPriceCash?: unknown }>(s: T) {
  return {
    ...s,
    unitPriceList: s.unitPriceList != null ? Number(s.unitPriceList) : null,
    unitPriceCash: s.unitPriceCash != null ? Number(s.unitPriceCash) : null,
  };
}

// Crear — solo admin.
services.post("/", auth, requireAuth, requirePermission("catalogo", "manage"), zValidator("json", serviceBody.extend({ name: z.string().min(1).max(255) })), async (c) => {
  const db = createDb(c.env);
  const { machineId, ...body } = c.req.valid("json");
  const created = await createService(db, body);
  if (machineId !== undefined) await setServicePrimaryMachine(db, created.id, machineId ?? null);
  return c.json(serializeService(created), 201);
});

// Editar — admin + manager + operator.
services.patch("/:id", auth, requireAuth, requirePermission("catalogo", "edit"), zValidator("json", serviceBody), async (c) => {
  const db = createDb(c.env);
  const id = c.req.param("id");
  const { machineId, ...patch } = c.req.valid("json");
  const updated = await updateService(db, id, patch);
  if (!updated) throw notFound("Service");
  if (machineId !== undefined) await setServicePrimaryMachine(db, id, machineId ?? null);
  return c.json(serializeService(updated));
});

// Archivar (soft-delete) — solo admin.
services.delete("/:id", auth, requireAuth, requirePermission("catalogo", "manage"), async (c) => {
  const db = createDb(c.env);
  const archived = await setServiceActive(db, c.req.param("id"), false);
  if (!archived) throw notFound("Service");
  return c.json(serializeService(archived));
});

// Restaurar — solo admin.
services.post("/:id/restore", auth, requireAuth, requirePermission("catalogo", "manage"), async (c) => {
  const db = createDb(c.env);
  const restored = await setServiceActive(db, c.req.param("id"), true);
  if (!restored) throw notFound("Service");
  return c.json(serializeService(restored));
});

// Impacto de un hard-delete: qué se borraría en cascada y si está bloqueado
// por turnos/facturas. Solo admin — es el paso previo al DELETE /:id/permanent.
services.get(
  "/:id/delete-impact",
  auth,
  requireAuth,
  requireAdmin,
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const svc = await getServiceById(db, id);
    if (!svc) throw notFound("Service");
    return c.json(await getServiceDeleteImpact(db, id));
  },
);

// Hard-delete real (no el soft-delete de DELETE /:id). Solo admin. Cascada sobre
// datos operativos; bloquea si hay turnos o facturas asociados (reglas_negocio §1.3/§5.1).
services.delete(
  "/:id/permanent",
  auth,
  requireAuth,
  requireAdmin,
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const svc = await getServiceById(db, id);
    if (!svc) throw notFound("Service");

    const impact = await getServiceDeleteImpact(db, id);
    if (impact.blocked) throw badRequest(impact.blockReason!);

    try {
      await hardDeleteService(db, id);
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw badRequest(
          "No se puede eliminar: apareció una referencia nueva justo ahora. Archivalo en su lugar.",
        );
      }
      throw err;
    }
    return c.json({ deleted: true });
  },
);

// ── Relaciones del servicio (categorías + acuerdos con proveedoras) ──────────

// Reemplaza las categorías del servicio (M:N). Staff.
services.put(
  "/:id/categories",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", z.object({ categoryIds: z.array(z.string().uuid()).default([]) })),
  async (c) => {
    const db = createDb(c.env);
    await setServiceCategories(db, c.req.param("id"), c.req.valid("json").categoryIds);
    return c.json({ ok: true });
  },
);

// Acuerdos vigentes (proveedora + tipo de pago + tarifa) para prefill del modal. Staff.
services.get("/:id/agreements", auth, requireAuth, requirePermission("catalogo", "edit"), async (c) => {
  const db = createDb(c.env);
  const rows = await listAgreementRowsForService(db, c.req.param("id"));
  return c.json(rows);
});

// Reconcilia los acuerdos del servicio respetando §4 (cierra viejo + crea nuevo). Staff.
const agreementSchema = z.object({
  serviceProviderId: z.string().uuid(),
  paymentType: z.enum(["per_hour", "percentage", "fixed_per_service"]).nullish(),
  rate: z.number().nonnegative().nullish(),
});
services.put(
  "/:id/agreements",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", z.object({ agreements: z.array(agreementSchema).default([]) })),
  async (c) => {
    const db = createDb(c.env);
    const desired = c.req.valid("json").agreements.map((a) => ({
      serviceProviderId: a.serviceProviderId,
      paymentType: a.paymentType ?? null,
      rate: a.rate ?? null,
    }));
    await setServiceAgreements(db, c.req.param("id"), desired, todayLocal());
    return c.json({ ok: true });
  },
);

export { services };

const providersRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// GET público (booking): proveedoras activas, opcionalmente por servicio. Campos
// mínimos (sin PII) porque este endpoint no exige auth.
providersRouter.get(
  "/",
  zValidator("query", z.object({ serviceId: z.string().uuid().optional() })),
  async (c) => {
    const db = createDb(c.env);
    const { serviceId } = c.req.valid("query");
    return c.json(await listActiveProviders(db, serviceId));
  },
);

// Lista completa para la vista admin (incluye PII + archivadas). Solo staff.
providersRouter.get(
  "/all",
  auth,
  requireAuth,
  requirePermission("proveedoras", "view"),
  zValidator("query", z.object({ includeInactive: z.string().optional() })),
  async (c) => {
    const db = createDb(c.env);
    const includeInactive = c.req.valid("query").includeInactive === "true";
    return c.json(await listProvidersAdmin(db, includeInactive));
  },
);

const providerBody = z.object({
  fullName: z.string().min(1).max(255).optional(),
  email: z.string().email().max(255).nullish(),
  phone: z.string().max(50).nullish(),
  dni: z.string().max(50).nullish(),
  cuit: z.string().max(50).nullish(),
  specialties: z.string().max(2000).nullish(),
  notes: z.string().max(2000).nullish(),
  address: z.string().max(255).nullish(),
  postalCode: z.string().max(20).nullish(),
});

// Crear — solo admin.
providersRouter.post(
  "/",
  auth,
  requireAuth,
  requirePermission("proveedoras", "manage"),
  zValidator("json", providerBody.extend({ fullName: z.string().min(1).max(255) })),
  async (c) => {
    const db = createDb(c.env);
    const created = await createProvider(db, c.req.valid("json"));
    return c.json(created, 201);
  },
);

// Editar — admin + manager + operator.
providersRouter.patch(
  "/:id",
  auth,
  requireAuth,
  requirePermission("proveedoras", "edit"),
  zValidator("json", providerBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateProvider(db, c.req.param("id"), c.req.valid("json"));
    if (!updated) throw notFound("Provider");
    return c.json(updated);
  },
);

// Archivar (soft-delete) — solo admin.
providersRouter.delete("/:id", auth, requireAuth, requirePermission("proveedoras", "manage"), async (c) => {
  const db = createDb(c.env);
  const archived = await setProviderStatus(db, c.req.param("id"), "inactive");
  if (!archived) throw notFound("Provider");
  return c.json(archived);
});

// Restaurar — solo admin.
providersRouter.post("/:id/restore", auth, requireAuth, requirePermission("proveedoras", "manage"), async (c) => {
  const db = createDb(c.env);
  const restored = await setProviderStatus(db, c.req.param("id"), "active");
  if (!restored) throw notFound("Provider");
  return c.json(restored);
});

// Impacto de un hard-delete: qué se borraría en cascada y si está bloqueado
// por turnos/pagos recibidos. Solo admin.
providersRouter.get(
  "/:id/delete-impact",
  auth,
  requireAuth,
  requireAdmin,
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const provider = await getProviderById(db, id);
    if (!provider) throw notFound("Provider");
    return c.json(await getProviderDeleteImpact(db, id));
  },
);

// Hard-delete real (no el soft-delete de DELETE /:id). Solo admin. Cascada sobre
// datos operativos; bloquea si hay turnos o pagos asociados.
providersRouter.delete(
  "/:id/permanent",
  auth,
  requireAuth,
  requireAdmin,
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const provider = await getProviderById(db, id);
    if (!provider) throw notFound("Provider");

    const impact = await getProviderDeleteImpact(db, id);
    if (impact.blocked) throw badRequest(impact.blockReason!);

    try {
      await hardDeleteProvider(db, id);
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw badRequest(
          "No se puede eliminar: apareció una referencia nueva justo ahora. Archivalo en su lugar.",
        );
      }
      throw err;
    }
    return c.json({ deleted: true });
  },
);

providersRouter.get(
  "/schedule",
  zValidator("query", z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  async (c) => {
    const db = createDb(c.env);
    const schedules = await getProviderSchedules(db, c.req.valid("query").date);
    return c.json(schedules);
  },
);

providersRouter.get("/:id/services", async (c) => {
  const db = createDb(c.env);
  const rows = await listServicesForProvider(db, c.req.param("id"));
  return c.json(
    rows.map((r) => ({
      ...r,
      unitPriceList: r.unitPriceList != null ? Number(r.unitPriceList) : null,
      unitPriceCash: r.unitPriceCash != null ? Number(r.unitPriceCash) : null,
    })),
  );
});

// ── Cuentas de MercadoPago de la proveedora (alias / CVU) ───────────────────
// Una proveedora puede tener varias cuentas (1:N). Ver reglas_negocio §4.9.
const mpBody = z.object({
  alias: z.string().max(255).nullish(),
  cvu: z.string().max(34).nullish(),
  accountOwnerName: z.string().max(255).nullish(),
  accountEmail: z.string().email().max(255).nullish(),
});

providersRouter.get("/:id/mp-accounts", auth, requireAuth, requirePermission("proveedoras", "view"), async (c) => {
  const db = createDb(c.env);
  return c.json(await listMpAccountsByProvider(db, c.req.param("id")));
});

providersRouter.post(
  "/:id/mp-accounts",
  auth,
  requireAuth,
  requirePermission("proveedoras", "edit"),
  zValidator("json", mpBody),
  async (c) => {
    const body = c.req.valid("json");
    if (!body.alias && !body.cvu) {
      throw badRequest("Indicá al menos el alias o el CVU.");
    }
    const db = createDb(c.env);
    return c.json(await createMpAccount(db, c.req.param("id"), body), 201);
  },
);

providersRouter.patch(
  "/mp-accounts/:accountId",
  auth,
  requireAuth,
  requirePermission("proveedoras", "edit"),
  zValidator("json", mpBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateMpAccount(db, c.req.param("accountId"), c.req.valid("json"));
    if (!updated) throw notFound("MercadopagoAccount");
    return c.json(updated);
  },
);

providersRouter.delete("/mp-accounts/:accountId", auth, requireAuth, requirePermission("proveedoras", "manage"), async (c) => {
  const db = createDb(c.env);
  const deleted = await deleteMpAccount(db, c.req.param("accountId"));
  if (!deleted) throw notFound("MercadopagoAccount");
  return c.json({ ok: true });
});

// ── Disponibilidad semanal (service_provider_availability) ──────────────────
const weeklyRowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(5), // sábado (6) se maneja en /availability/saturdays
  workStartTime: z.string().regex(/^\d{2}:\d{2}$/),
  workEndTime: z.string().regex(/^\d{2}:\d{2}$/),
});

/**
 * GET /api/agenda/providers/availability/weekly
 * Horario semanal de todas las proveedoras, indexado por su id.
 *
 * Lo consume el selector de profe al crear/editar una Actividad: hay que ver
 * los horarios de todas juntos para elegir, y pedirlos de a uno serían tantos
 * requests como proveedoras.
 *
 * Va ANTES que "/:id/availability/weekly" por claridad; no compiten igual,
 * porque tienen distinta cantidad de segmentos.
 */
providersRouter.get(
  "/availability/weekly",
  auth,
  requireAuth,
  requirePermission("proveedoras", "view"),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await listWeeklyAvailabilityForAllProviders(db));
  },
);

providersRouter.get(
  "/:id/availability/weekly",
  auth,
  requireAuth,
  requirePermission("proveedoras", "view"),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await listWeeklyAvailability(db, c.req.param("id")));
  },
);

providersRouter.put(
  "/:id/availability/weekly",
  auth,
  requireAuth,
  requirePermission("proveedoras", "edit"),
  zValidator("json", z.object({ rows: z.array(weeklyRowSchema).default([]) })),
  async (c) => {
    const db = createDb(c.env);
    const rows = await setWeeklyAvailability(
      db,
      c.req.param("id"),
      c.req.valid("json").rows,
      todayLocal(),
    );
    return c.json(rows);
  },
);

// ── Sábados puntuales (provider_saturday_schedule) ──────────────────────────
const saturdayBody = z.object({
  saturdayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  isWorking: z.boolean(),
  workStartTime: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
  workEndTime: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
  notes: z.string().max(2000).nullish(),
});

providersRouter.get(
  "/:id/availability/saturdays",
  auth,
  requireAuth,
  requirePermission("proveedoras", "view"),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await listSaturdaySchedule(db, c.req.param("id")));
  },
);

providersRouter.post(
  "/:id/availability/saturdays",
  auth,
  requireAuth,
  requirePermission("proveedoras", "edit"),
  zValidator("json", saturdayBody),
  async (c) => {
    const db = createDb(c.env);
    const created = await addSaturdaySchedule(db, c.req.param("id"), c.req.valid("json"));
    return c.json(created, 201);
  },
);

providersRouter.delete(
  "/:id/availability/saturdays/:rowId",
  auth,
  requireAuth,
  requirePermission("proveedoras", "edit"),
  async (c) => {
    const db = createDb(c.env);
    const deleted = await deleteSaturdaySchedule(db, c.req.param("id"), c.req.param("rowId"));
    if (!deleted) throw notFound("SaturdaySchedule");
    return c.json({ ok: true });
  },
);

// ── Excepciones (provider_availability_exceptions) ──────────────────────────
const exceptionBody = z
  .object({
    exceptionType: z.enum([
      "unavailable",
      "sick_leave",
      "vacation",
      "reduced_hours",
      "not_coming",
      "other",
    ]),
    dateException: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    dateStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    dateEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    timeOverrideStart: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
    timeOverrideEnd: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
    reason: z.string().max(2000).nullish(),
    isWorking: z.boolean(),
  })
  .refine((b) => Boolean(b.dateException) !== Boolean(b.dateStart && b.dateEnd), {
    message:
      "Indicá una fecha única (dateException) o un rango (dateStart y dateEnd), no ambos ni ninguno.",
  });

providersRouter.get(
  "/:id/availability/exceptions",
  auth,
  requireAuth,
  requirePermission("proveedoras", "view"),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await listExceptions(db, c.req.param("id")));
  },
);

providersRouter.post(
  "/:id/availability/exceptions",
  auth,
  requireAuth,
  requirePermission("proveedoras", "edit"),
  zValidator("json", exceptionBody),
  async (c) => {
    const db = createDb(c.env);
    const providerId = c.req.param("id");
    const data = c.req.valid("json");
    const created = await addException(db, providerId, data);

    let conflictingAppointments: Awaited<ReturnType<typeof listAppointmentsByRange>> = [];
    if (data.isWorking === false) {
      const from = data.dateException ?? data.dateStart!;
      const to = data.dateException ?? data.dateEnd!;
      const range = {
        start: localDayRangeUtc(from).start,
        end: localDayRangeUtc(to).end,
      };
      conflictingAppointments = await listAppointmentsByRange(db, range, {
        providerId,
        status: ["scheduled", "reserved"],
      });
    }

    return c.json({ ...created, conflictingAppointments }, 201);
  },
);

providersRouter.delete(
  "/:id/availability/exceptions/:rowId",
  auth,
  requireAuth,
  requirePermission("proveedoras", "edit"),
  async (c) => {
    const db = createDb(c.env);
    const deleted = await deleteException(db, c.req.param("id"), c.req.param("rowId"));
    if (!deleted) throw notFound("AvailabilityException");
    return c.json({ ok: true });
  },
);

export { providersRouter };
