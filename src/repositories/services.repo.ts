import { and, asc, eq, ilike, inArray } from "drizzle-orm";
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
};

export async function listServices(
  db: Db,
  filters: { categoryId?: string; q?: string },
) {
  const conditions = [eq(service.isActive, true)];
  if (filters.q) conditions.push(ilike(service.name, `%${filters.q}%`));

  if (filters.categoryId) {
    const rows = await db
      .select(serviceSummary)
      .from(service)
      .innerJoin(serviceCategory, eq(serviceCategory.serviceId, service.id))
      .where(and(...conditions, eq(serviceCategory.categoryId, filters.categoryId)))
      .orderBy(asc(service.name));
    return rows;
  }

  return db
    .select(serviceSummary)
    .from(service)
    .where(and(...conditions))
    .orderBy(asc(service.name));
}

export async function getServiceById(db: Db, id: string) {
  const rows = await db.select(serviceSummary).from(service).where(eq(service.id, id)).limit(1);
  return rows[0] ?? null;
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
