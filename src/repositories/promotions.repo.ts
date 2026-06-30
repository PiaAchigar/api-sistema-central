import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { promotions, promotionService, service, serviceProviders } from "../db/schema";
import { applyDiscount } from "../lib/promo-pricing";

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

// ── CRUD admin de promos (cabecera + líneas con proveedora/pago + snapshot) ──

export type PromoLineInput = {
  serviceId: string;
  serviceProviderId?: string | null;
  providerPayment?: number | null;
};
export type PromoHeaderInput = {
  name: string;
  description?: string | null;
  promotionType?: string | null; // 'percentage' | 'fixed_amount'
  discountPercentage?: number | null;
  discountAmount?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
  isFeatured?: boolean | null;
  usageLimit?: number | null;
  notes?: string | null;
};

const dec = (v: number | null | undefined) => (v == null ? null : String(v));

const promoFields = {
  id: promotions.id,
  name: promotions.name,
  description: promotions.description,
  promotionType: promotions.promotionType,
  discountPercentage: promotions.discountPercentage,
  discountAmount: promotions.discountAmount,
  servicesSubtotal: promotions.servicesSubtotal,
  finalAmount: promotions.finalAmount,
  validFrom: promotions.validFrom,
  validUntil: promotions.validUntil,
  status: promotions.status,
  isFeatured: promotions.isFeatured,
  usageLimit: promotions.usageLimit,
  notes: promotions.notes,
};

async function linesFor(db: Db, promotionId: string) {
  return db
    .select({
      id: promotionService.id,
      serviceId: promotionService.serviceId,
      serviceName: service.name,
      serviceProviderId: promotionService.serviceProviderId,
      serviceProviderName: serviceProviders.fullName,
      servicePrice: promotionService.servicePrice,
      providerPayment: promotionService.providerPayment,
    })
    .from(promotionService)
    .leftJoin(service, eq(promotionService.serviceId, service.id))
    .leftJoin(serviceProviders, eq(promotionService.serviceProviderId, serviceProviders.id))
    .where(eq(promotionService.promotionId, promotionId));
}

// Friza precios de lista de los servicios elegidos + subtotal + total.
async function freeze(db: Db, header: PromoHeaderInput, lines: PromoLineInput[]) {
  const ids = lines.map((l) => l.serviceId);
  const priced = ids.length
    ? await db
        .select({ id: service.id, price: service.unitPriceList })
        .from(service)
        .where(inArray(service.id, ids))
    : [];
  const priceById = new Map(priced.map((p) => [p.id, p.price ? Number(p.price) : 0]));
  const linesFrozen = lines.map((l) => ({ ...l, servicePrice: priceById.get(l.serviceId) ?? 0 }));
  const subtotal = linesFrozen.reduce((acc, l) => acc + l.servicePrice, 0);
  const finalAmount = applyDiscount(
    subtotal,
    header.promotionType ?? null,
    header.discountPercentage ?? null,
    header.discountAmount ?? null,
  );
  return { linesFrozen, subtotal, finalAmount };
}

export async function listPromotions(db: Db, includeInactive = false) {
  const base = db.select(promoFields).from(promotions);
  const rows = includeInactive ? await base : await base.where(ne(promotions.status, "inactive"));
  const out = [];
  for (const p of rows) out.push({ ...p, lines: await linesFor(db, p.id) });
  return out;
}

export async function getPromotionById(db: Db, id: string) {
  const [p] = await db.select(promoFields).from(promotions).where(eq(promotions.id, id)).limit(1);
  if (!p) return null;
  return { ...p, lines: await linesFor(db, id) };
}

async function writeLines(
  db: Db,
  promotionId: string,
  linesFrozen: (PromoLineInput & { servicePrice: number })[],
) {
  await db.delete(promotionService).where(eq(promotionService.promotionId, promotionId));
  if (linesFrozen.length === 0) return;
  await db.insert(promotionService).values(
    linesFrozen.map((l) => ({
      promotionId,
      serviceId: l.serviceId,
      serviceProviderId: l.serviceProviderId ?? null,
      servicePrice: dec(l.servicePrice),
      providerPayment: dec(l.providerPayment ?? null),
    })),
  );
}

export async function createPromotion(db: Db, header: PromoHeaderInput, lines: PromoLineInput[]) {
  const { linesFrozen, subtotal, finalAmount } = await freeze(db, header, lines);
  const [created] = await db
    .insert(promotions)
    .values({
      name: header.name,
      description: header.description ?? null,
      promotionType: header.promotionType ?? null,
      discountPercentage: dec(header.discountPercentage ?? null),
      discountAmount: dec(header.discountAmount ?? null),
      servicesSubtotal: dec(subtotal),
      finalAmount: dec(finalAmount),
      validFrom: header.validFrom ?? null,
      validUntil: header.validUntil ?? null,
      status: "active",
      isFeatured: header.isFeatured ?? false,
      usageLimit: header.usageLimit ?? null,
      notes: header.notes ?? null,
    })
    .returning({ id: promotions.id });
  if (!created) return null;
  await writeLines(db, created.id, linesFrozen);
  return getPromotionById(db, created.id);
}

export async function updatePromotion(
  db: Db,
  id: string,
  header: PromoHeaderInput,
  lines: PromoLineInput[],
) {
  const { linesFrozen, subtotal, finalAmount } = await freeze(db, header, lines);
  const updated = await db
    .update(promotions)
    .set({
      name: header.name,
      description: header.description ?? null,
      promotionType: header.promotionType ?? null,
      discountPercentage: dec(header.discountPercentage ?? null),
      discountAmount: dec(header.discountAmount ?? null),
      servicesSubtotal: dec(subtotal),
      finalAmount: dec(finalAmount),
      validFrom: header.validFrom ?? null,
      validUntil: header.validUntil ?? null,
      isFeatured: header.isFeatured ?? false,
      usageLimit: header.usageLimit ?? null,
      notes: header.notes ?? null,
    })
    .where(eq(promotions.id, id))
    .returning({ id: promotions.id });
  if (updated.length === 0) return null;
  await writeLines(db, id, linesFrozen);
  return getPromotionById(db, id);
}

export async function setPromotionStatus(db: Db, id: string, status: "active" | "inactive") {
  const rows = await db
    .update(promotions)
    .set({ status })
    .where(eq(promotions.id, id))
    .returning({ id: promotions.id });
  if (rows.length === 0) return null;
  return getPromotionById(db, id);
}
