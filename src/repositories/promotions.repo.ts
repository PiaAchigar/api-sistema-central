import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { promotions, promotionService, service } from "../db/schema";

export async function listActivePromotions(
  db: Db,
  filters: { featured?: boolean } = {},
) {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const conditions = [
    eq(promotions.status, "active"),
    or(isNull(promotions.validUntil), sql`${promotions.validUntil} >= ${today}::date`),
  ];
  if (filters.featured) conditions.push(eq(promotions.isFeatured, true));

  const activePromos = await db
    .select({
      id: promotions.id,
      name: promotions.name,
      description: promotions.description,
      promotionType: promotions.promotionType,
      discountPercentage: promotions.discountPercentage,
      discountAmount: promotions.discountAmount,
      validFrom: promotions.validFrom,
      validUntil: promotions.validUntil,
      isFeatured: promotions.isFeatured,
    })
    .from(promotions)
    .where(and(...conditions))
    .orderBy(asc(promotions.name));

  if (activePromos.length === 0) return [];

  const promoIds = activePromos.map((p) => p.id);

  const links = await db
    .select({
      promotionId: promotionService.promotionId,
      serviceId: service.id,
      serviceName: service.name,
      unitPriceList: service.unitPriceList,
      unitPriceCash: service.unitPriceCash,
      estimatedDurationMinutes: service.estimatedDurationMinutes,
    })
    .from(promotionService)
    .innerJoin(service, eq(service.id, promotionService.serviceId))
    .where(
      and(
        inArray(promotionService.promotionId, promoIds),
        eq(service.isActive, true),
      ),
    );

  const servicesByPromo = new Map<string, typeof links>();
  for (const link of links) {
    if (!link.promotionId) continue;
    const list = servicesByPromo.get(link.promotionId) ?? [];
    list.push(link);
    servicesByPromo.set(link.promotionId, list);
  }

  return activePromos.map((p) => ({
    ...p,
    discountPercentage: p.discountPercentage != null ? Number(p.discountPercentage) : null,
    discountAmount: p.discountAmount != null ? Number(p.discountAmount) : null,
    services: (servicesByPromo.get(p.id) ?? []).map((s) => ({
      id: s.serviceId,
      name: s.serviceName,
      unitPriceList: s.unitPriceList != null ? Number(s.unitPriceList) : null,
      unitPriceCash: s.unitPriceCash != null ? Number(s.unitPriceCash) : null,
      estimatedDurationMinutes: s.estimatedDurationMinutes,
    })),
  }));
}

export async function updatePromotionFeatured(
  db: Db,
  id: string,
  isFeatured: boolean,
) {
  const result = await db
    .update(promotions)
    .set({ isFeatured })
    .where(eq(promotions.id, id))
    .returning({ id: promotions.id, isFeatured: promotions.isFeatured });

  return result[0] ?? null;
}
