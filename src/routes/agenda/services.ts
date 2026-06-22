import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { notFound } from "../../lib/errors";
import { auth, requireAuth } from "../../middleware/auth";
import { getActiveAgreementsForService, listActiveProviders } from "../../repositories/providers.repo";
import { getProviderSchedules } from "../../services/availability.service";
import {
  getCategoriesForServices,
  getMachinesForService,
  getServiceById,
  listServices,
  listServicesForProvider,
  updateServiceWebSettings,
} from "../../repositories/services.repo";
import { todayLocal } from "../../lib/time";
import type { AppBindings } from "../../env";

const services = new Hono<{ Bindings: AppBindings }>();

const listQuery = z.object({
  categoryId: z.string().uuid().optional(),
  q: z.string().max(100).optional(),
  featured: z.string().optional().transform((v) => v === "true"),
});

services.get("/", zValidator("query", listQuery), async (c) => {
  const db = createDb(c.env);
  const filters = c.req.valid("query");
  const rows = await listServices(db, {
    categoryId: filters.categoryId,
    q: filters.q,
    featured: filters.featured,
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

const patchServiceBody = z.object({
  isFeatured: z.boolean().optional(),
  webSortOrder: z.number().int().min(0).optional(),
});

services.patch("/:id", auth, requireAuth, zValidator("json", patchServiceBody), async (c) => {
  const db = createDb(c.env);
  const id = c.req.param("id");
  const patch = c.req.valid("json");
  const updated = await updateServiceWebSettings(db, id, patch);
  if (!updated) return c.json({ error: "Service not found" }, 404);
  return c.json(updated);
});

export { services };

const providersRouter = new Hono<{ Bindings: AppBindings }>();

providersRouter.get(
  "/",
  zValidator("query", z.object({ serviceId: z.string().uuid().optional() })),
  async (c) => {
    const db = createDb(c.env);
    const { serviceId } = c.req.valid("query");
    return c.json(await listActiveProviders(db, serviceId));
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

export { providersRouter };
