import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { auth, requireAdmin, requireAuth, requireRole } from "../../middleware/auth";
import {
  createProvider,
  getActiveAgreementsForService,
  listActiveProviders,
  listProvidersAdmin,
  setProviderStatus,
  updateProvider,
} from "../../repositories/providers.repo";
import { getProviderSchedules } from "../../services/availability.service";
import {
  createService,
  getCategoriesForServices,
  getMachinesForService,
  getServiceById,
  listServices,
  listServicesForProvider,
  setServiceActive,
  updateService,
} from "../../repositories/services.repo";
import { todayLocal } from "../../lib/time";
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

  const categoryRows = await getCategoriesForServices(db, rows.map((r) => r.id));
  const categoriesByService = new Map<string, { id: string; name: string | null }[]>();
  for (const cr of categoryRows) {
    if (!cr.serviceId) continue;
    const list = categoriesByService.get(cr.serviceId) ?? [];
    list.push({ id: cr.categoryId, name: cr.categoryName });
    categoriesByService.set(cr.serviceId, list);
  }

  return c.json(
    rows.map((r) => ({
      ...r,
      unitPriceList: r.unitPriceList != null ? Number(r.unitPriceList) : null,
      unitPriceCash: r.unitPriceCash != null ? Number(r.unitPriceCash) : null,
      categories: categoriesByService.get(r.id) ?? [],
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
  description: z.string().max(255).nullish(),
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
services.post("/", auth, requireAuth, requireAdmin, zValidator("json", serviceBody.extend({ name: z.string().min(1).max(255) })), async (c) => {
  const db = createDb(c.env);
  const created = await createService(db, c.req.valid("json"));
  return c.json(serializeService(created), 201);
});

// Editar — admin + manager + operator.
services.patch("/:id", auth, requireAuth, requireRole(...STAFF), zValidator("json", serviceBody), async (c) => {
  const db = createDb(c.env);
  const updated = await updateService(db, c.req.param("id"), c.req.valid("json"));
  if (!updated) throw notFound("Service");
  return c.json(serializeService(updated));
});

// Archivar (soft-delete) — solo admin.
services.delete("/:id", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const archived = await setServiceActive(db, c.req.param("id"), false);
  if (!archived) throw notFound("Service");
  return c.json(serializeService(archived));
});

// Restaurar — solo admin.
services.post("/:id/restore", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const restored = await setServiceActive(db, c.req.param("id"), true);
  if (!restored) throw notFound("Service");
  return c.json(serializeService(restored));
});

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
  requireRole(...STAFF),
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
  requireAdmin,
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
  requireRole(...STAFF),
  zValidator("json", providerBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateProvider(db, c.req.param("id"), c.req.valid("json"));
    if (!updated) throw notFound("Provider");
    return c.json(updated);
  },
);

// Archivar (soft-delete) — solo admin.
providersRouter.delete("/:id", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const archived = await setProviderStatus(db, c.req.param("id"), "inactive");
  if (!archived) throw notFound("Provider");
  return c.json(archived);
});

// Restaurar — solo admin.
providersRouter.post("/:id/restore", auth, requireAuth, requireAdmin, async (c) => {
  const db = createDb(c.env);
  const restored = await setProviderStatus(db, c.req.param("id"), "active");
  if (!restored) throw notFound("Provider");
  return c.json(restored);
});

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

export { providersRouter };
