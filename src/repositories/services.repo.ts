import { and, asc, eq, ilike, inArray, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  categories,
  machines,
  service,
  serviceCategory,
  serviceMachine,
  serviceProviderService,
} from "../db/schema";

const serviceSummary = {
  id: service.id,
  name: service.name,
  description: service.description,
  code: service.code,
  unitPriceList: service.unitPriceList,
  unitPriceCash: service.unitPriceCash,
  taxCategory: service.taxCategory,
  requiresOperator: service.requiresOperator,
  requiresMachine: service.requiresMachine,
  estimatedDurationMinutes: service.estimatedDurationMinutes,
  unitType: service.unitType,
  isActive: service.isActive,
  isFeatured: service.isFeatured,
  isVisible: service.isVisible,
  webSortOrder: service.webSortOrder,
};

export async function listServices(
  db: Db,
  filters: { categoryId?: string; q?: string; featured?: boolean; includeInactive?: boolean },
) {
  const conditions: SQL[] = [];
  if (!filters.includeInactive) conditions.push(eq(service.isActive, true));
  if (filters.q) conditions.push(ilike(service.name, `%${filters.q}%`));
  if (filters.featured) conditions.push(eq(service.isFeatured, true));

  if (filters.categoryId) {
    return db
      .select(serviceSummary)
      .from(service)
      .innerJoin(serviceCategory, eq(serviceCategory.serviceId, service.id))
      .where(and(...conditions, eq(serviceCategory.categoryId, filters.categoryId)))
      .orderBy(asc(service.webSortOrder), asc(service.name));
  }

  return db
    .select(serviceSummary)
    .from(service)
    .where(and(...conditions))
    .orderBy(asc(service.webSortOrder), asc(service.name));
}

export async function getServiceById(db: Db, id: string) {
  const rows = await db.select(serviceSummary).from(service).where(eq(service.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Reemplaza las categorías de un servicio (M:N). Patrón delete + insert. */
export async function setServiceCategories(db: Db, serviceId: string, categoryIds: string[]) {
  await db.delete(serviceCategory).where(eq(serviceCategory.serviceId, serviceId));
  if (categoryIds.length === 0) return;
  await db
    .insert(serviceCategory)
    .values(categoryIds.map((categoryId) => ({ serviceId, categoryId })));
}

export async function getCategoriesForServices(db: Db, serviceIds: string[]) {
  if (serviceIds.length === 0) return [];
  return db
    .select({
      serviceId: serviceCategory.serviceId,
      categoryId: categories.id,
      categoryName: categories.name,
    })
    .from(serviceCategory)
    .innerJoin(categories, eq(categories.id, serviceCategory.categoryId))
    .where(inArray(serviceCategory.serviceId, serviceIds));
}

export async function updateServiceWebSettings(
  db: Db,
  id: string,
  patch: { isFeatured?: boolean; webSortOrder?: number },
) {
  const result = await db
    .update(service)
    .set({
      ...(patch.isFeatured !== undefined && { isFeatured: patch.isFeatured }),
      ...(patch.webSortOrder !== undefined && { webSortOrder: patch.webSortOrder }),
    })
    .where(eq(service.id, id))
    .returning({
      id: service.id,
      isFeatured: service.isFeatured,
      webSortOrder: service.webSortOrder,
    });

  return result[0] ?? null;
}

/** Servicios activos que ofrece una prestadora (acuerdo activo + servicio activo). */
export async function listServicesForProvider(db: Db, providerId: string) {
  return db
    .select({
      id: service.id,
      name: service.name,
      estimatedDurationMinutes: service.estimatedDurationMinutes,
      unitPriceList: service.unitPriceList,
      unitPriceCash: service.unitPriceCash,
    })
    .from(serviceProviderService)
    .innerJoin(service, eq(service.id, serviceProviderService.serviceId))
    .where(
      and(
        eq(serviceProviderService.serviceProviderId, providerId),
        eq(serviceProviderService.isActive, true),
        eq(service.isActive, true),
      ),
    )
    .orderBy(asc(service.name));
}

/** Máquinas habilitadas para un servicio (activas, primarias primero). */
export async function getMachinesForService(db: Db, serviceId: string) {
  return db
    .select({
      machineId: machines.id,
      machineName: machines.name,
      machineStatus: machines.status,
      isPrimaryMachine: serviceMachine.isPrimaryMachine,
    })
    .from(serviceMachine)
    .innerJoin(machines, eq(machines.id, serviceMachine.machineId))
    .where(and(eq(serviceMachine.serviceId, serviceId), eq(machines.status, "active")));
}

/** Máquina principal (service_machine.is_primary_machine) por servicio, en batch. */
export async function getPrimaryMachinesForServices(db: Db, serviceIds: string[]) {
  if (serviceIds.length === 0) return [];
  return db
    .select({
      serviceId: serviceMachine.serviceId,
      machineId: machines.id,
      machineName: machines.name,
    })
    .from(serviceMachine)
    .innerJoin(machines, eq(machines.id, serviceMachine.machineId))
    .where(
      and(
        inArray(serviceMachine.serviceId, serviceIds),
        eq(serviceMachine.isPrimaryMachine, true),
      ),
    );
}

// ── Mutaciones (CRUD admin) ────────────────────────────────────────────────────

type ServiceWritable = {
  name?: string;
  description?: string | null;
  code?: string | null;
  unitPriceList?: number | null;
  unitPriceCash?: number | null;
  unitType?: string | null;
  taxCategory?: string | null;
  requiresOperator?: boolean | null;
  requiresMachine?: boolean | null;
  estimatedDurationMinutes?: number | null;
  isVisible?: boolean | null;
  isFeatured?: boolean | null;
  webSortOrder?: number | null;
};

/** Construye el `set` parcial; convierte decimales a string (lo que espera drizzle). */
function toServiceSet(p: ServiceWritable) {
  return {
    ...(p.name !== undefined && { name: p.name }),
    ...(p.description !== undefined && { description: p.description }),
    ...(p.code !== undefined && { code: p.code }),
    ...(p.unitPriceList !== undefined && {
      unitPriceList: p.unitPriceList === null ? null : String(p.unitPriceList),
    }),
    ...(p.unitPriceCash !== undefined && {
      unitPriceCash: p.unitPriceCash === null ? null : String(p.unitPriceCash),
    }),
    ...(p.unitType !== undefined && { unitType: p.unitType }),
    ...(p.taxCategory !== undefined && { taxCategory: p.taxCategory }),
    ...(p.requiresOperator !== undefined && { requiresOperator: p.requiresOperator }),
    ...(p.requiresMachine !== undefined && { requiresMachine: p.requiresMachine }),
    ...(p.estimatedDurationMinutes !== undefined && {
      estimatedDurationMinutes: p.estimatedDurationMinutes,
    }),
    ...(p.isVisible !== undefined && { isVisible: p.isVisible }),
    ...(p.isFeatured !== undefined && { isFeatured: p.isFeatured }),
    // web_sort_order es NOT NULL DEFAULT 0 en la base; null explícito rompe el insert/update.
    ...(p.webSortOrder !== undefined && { webSortOrder: p.webSortOrder ?? 0 }),
  };
}

export async function createService(db: Db, data: ServiceWritable & { name: string }) {
  const rows = await db
    .insert(service)
    .values({ ...toServiceSet(data), isActive: true })
    .returning(serviceSummary);
  return rows[0]!;
}

export async function updateService(db: Db, id: string, patch: ServiceWritable) {
  const rows = await db
    .update(service)
    .set(toServiceSet(patch))
    .where(eq(service.id, id))
    .returning(serviceSummary);
  return rows[0] ?? null;
}

/** Soft-delete / restore (regla 1.3). */
export async function setServiceActive(db: Db, id: string, isActive: boolean) {
  const rows = await db
    .update(service)
    .set({ isActive })
    .where(eq(service.id, id))
    .returning(serviceSummary);
  return rows[0] ?? null;
}
