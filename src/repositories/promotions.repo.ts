import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  combos,
  depilationCombo,
  promotions,
  promotionService,
  promotionTarget,
  service,
  serviceProviders,
} from "../db/schema";
import type { TipoDeDestino } from "../lib/promo-aplica";
import { promoEstaVigente } from "../lib/promo-vigente";
import { todayLocal } from "../lib/time";

export async function listActivePromotions(
  db: Db,
  filters: { featured?: boolean } = {},
) {
  // Hoy en hora LOCAL del negocio: en UTC, entre las 21:00 y las 24:00 ART ya
  // es mañana, y una promo que vence hoy desaparecía tres horas antes de tiempo.
  const today = todayLocal();

  // La web pública sólo ve lo que Laura publicó (`isVisibleWeb`). `featured`
  // exige ADEMÁS `isFeatured`: la home muestra un subconjunto de lo
  // publicado, nunca algo que no esté publicado.
  const conditions = [eq(promotions.status, "active"), eq(promotions.isVisibleWeb, true)];
  if (filters.featured) conditions.push(eq(promotions.isFeatured, true));

  const rows = await db
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

  // Vigencia por fecha en lógica pura (`promoEstaVigente`), no en SQL: mismo
  // criterio que usa la venta (`listPromosVendibles`) y evita la regla que ya
  // nos costó un 500 en producción sobre este mismo archivo — un objeto
  // `Date` metido en un fragmento `sql` crudo. Acá ni siquiera hay ese
  // riesgo (serían strings), pero un solo criterio de vigencia en un único
  // lugar es más fácil de seguir que repetirlo en SQL y en JS.
  const activePromos = rows.filter((p) => promoEstaVigente(p, today));
  if (activePromos.length === 0) return [];

  const out = [];
  for (const p of activePromos) {
    out.push({
      ...p,
      discountPercentage: p.discountPercentage != null ? Number(p.discountPercentage) : null,
      discountAmount: p.discountAmount != null ? Number(p.discountAmount) : null,
      targets: await destinosDe(db, p.id),
    });
  }
  return out;
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

// ── CRUD admin de promos (cabecera + destinos + pagos acordados) ────────────

export type PromoDestinoInput = { tipo: TipoDeDestino; id: string };
export type PromoPagoInput = {
  serviceId: string;
  serviceProviderId: string;
  providerPayment: number;
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
  isVisibleWeb?: boolean | null;
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
  validFrom: promotions.validFrom,
  validUntil: promotions.validUntil,
  status: promotions.status,
  isFeatured: promotions.isFeatured,
  isVisibleWeb: promotions.isVisibleWeb,
  usageLimit: promotions.usageLimit,
  notes: promotions.notes,
};

/** La columna de `promotion_target` donde vive cada tipo de destino. */
const COLUMNA_DE_TIPO = {
  servicio: promotionTarget.serviceId,
  combo: promotionTarget.comboId,
  depilacion: promotionTarget.depilationComboId,
} as const;

/**
 * Los destinos de una promo, con el nombre de cada uno.
 *
 * Se leen los tres tipos por separado porque cada uno vive en su tabla: no hay
 * un join único posible, y forzarlo con COALESCE haría una consulta ilegible
 * para ahorrar dos viajes contra tablas de catálogo (que son chicas).
 */
async function destinosDe(db: Db, promotionId: string) {
  const filas = await db
    .select({
      id: promotionTarget.id,
      serviceId: promotionTarget.serviceId,
      comboId: promotionTarget.comboId,
      depilationComboId: promotionTarget.depilationComboId,
      serviceName: service.name,
      comboName: combos.name,
      depilationComboName: depilationCombo.name,
    })
    .from(promotionTarget)
    .leftJoin(service, eq(service.id, promotionTarget.serviceId))
    .leftJoin(combos, eq(combos.id, promotionTarget.comboId))
    .leftJoin(depilationCombo, eq(depilationCombo.id, promotionTarget.depilationComboId))
    .where(eq(promotionTarget.promotionId, promotionId));

  // Anotado explícito: sin él, TS infiere cada `return` del flatMap con su
  // literal propio ("servicio" | "combo" | "depilacion") y los tres arrays no
  // unifican en un solo tipo de retorno válido para el callback.
  type DestinoConNombre = { filaId: string; tipo: TipoDeDestino; id: string; nombre: string | null };
  return filas.flatMap((f): DestinoConNombre[] => {
    if (f.serviceId) return [{ filaId: f.id, tipo: "servicio", id: f.serviceId, nombre: f.serviceName }];
    if (f.comboId) return [{ filaId: f.id, tipo: "combo", id: f.comboId, nombre: f.comboName }];
    if (f.depilationComboId)
      return [{ filaId: f.id, tipo: "depilacion", id: f.depilationComboId, nombre: f.depilationComboName }];
    // El CHECK ck_pt_destino_unico lo impide, pero una fila sin destino no es
    // un destino: se ignora en vez de romper la pantalla entera.
    return [];
  });
}

/** Lo acordado con cada proveedora para esta promo. */
async function pagosDe(db: Db, promotionId: string) {
  const filas = await db
    .select({
      id: promotionService.id,
      serviceId: promotionService.serviceId,
      serviceName: service.name,
      serviceProviderId: promotionService.serviceProviderId,
      serviceProviderName: serviceProviders.fullName,
      providerPayment: promotionService.providerPayment,
    })
    .from(promotionService)
    .leftJoin(service, eq(promotionService.serviceId, service.id))
    .leftJoin(serviceProviders, eq(promotionService.serviceProviderId, serviceProviders.id))
    .where(eq(promotionService.promotionId, promotionId));

  // `providerPayment` es numeric: drizzle lo trae como string. Sin convertir
  // acá, la pantalla y este mismo repo lo comparan como texto.
  return filas.map((f) => ({ ...f, providerPayment: Number(f.providerPayment) }));
}

async function escribirDestinos(db: Db, promotionId: string, destinos: PromoDestinoInput[]) {
  await db.delete(promotionTarget).where(eq(promotionTarget.promotionId, promotionId));
  if (destinos.length === 0) return;
  // Sin deduplicar, ux_pt rechaza el lote entero y Laura pierde la promo por
  // haber tildado dos veces lo mismo.
  const unicos = [...new Map(destinos.map((d) => [`${d.tipo}:${d.id}`, d])).values()];
  await db.insert(promotionTarget).values(
    unicos.map((d) => ({
      promotionId,
      serviceId: d.tipo === "servicio" ? d.id : null,
      comboId: d.tipo === "combo" ? d.id : null,
      depilationComboId: d.tipo === "depilacion" ? d.id : null,
      bodyZoneId: null,
    })),
  );
}

async function escribirPagos(db: Db, promotionId: string, pagos: PromoPagoInput[]) {
  await db.delete(promotionService).where(eq(promotionService.promotionId, promotionId));
  if (pagos.length === 0) return;
  // Un pago por (servicio, proveedora): un servicio que está en dos combos de
  // la misma promo lleva UNO, no dos. Gana el último que mandó la pantalla.
  const unicos = [
    ...new Map(pagos.map((p) => [`${p.serviceId}:${p.serviceProviderId}`, p])).values(),
  ];
  await db.insert(promotionService).values(
    unicos.map((p) => ({
      promotionId,
      serviceId: p.serviceId,
      serviceProviderId: p.serviceProviderId,
      providerPayment: String(p.providerPayment),
    })),
  );
}

export async function listPromotions(db: Db, includeInactive = false) {
  const base = db.select(promoFields).from(promotions);
  const rows = includeInactive ? await base : await base.where(ne(promotions.status, "inactive"));
  const out = [];
  for (const p of rows) {
    out.push({ ...p, destinos: await destinosDe(db, p.id), pagos: await pagosDe(db, p.id) });
  }
  return out;
}

export async function getPromotionById(db: Db, id: string) {
  const [p] = await db.select(promoFields).from(promotions).where(eq(promotions.id, id)).limit(1);
  if (!p) return null;
  return { ...p, destinos: await destinosDe(db, id), pagos: await pagosDe(db, id) };
}

export async function createPromotion(
  db: Db,
  header: PromoHeaderInput,
  destinos: PromoDestinoInput[],
  pagos: PromoPagoInput[],
) {
  const [created] = await db
    .insert(promotions)
    .values({
      name: header.name,
      description: header.description ?? null,
      promotionType: header.promotionType ?? null,
      discountPercentage: dec(header.discountPercentage ?? null),
      discountAmount: dec(header.discountAmount ?? null),
      validFrom: header.validFrom ?? null,
      validUntil: header.validUntil ?? null,
      status: "active",
      isFeatured: header.isFeatured ?? false,
      isVisibleWeb: header.isVisibleWeb ?? false,
      usageLimit: header.usageLimit ?? null,
      notes: header.notes ?? null,
    })
    .returning({ id: promotions.id });
  if (!created) return null;
  await escribirDestinos(db, created.id, destinos);
  await escribirPagos(db, created.id, pagos);
  return getPromotionById(db, created.id);
}

export async function updatePromotion(
  db: Db,
  id: string,
  header: PromoHeaderInput,
  destinos: PromoDestinoInput[],
  pagos: PromoPagoInput[],
) {
  const updated = await db
    .update(promotions)
    .set({
      name: header.name,
      description: header.description ?? null,
      promotionType: header.promotionType ?? null,
      discountPercentage: dec(header.discountPercentage ?? null),
      discountAmount: dec(header.discountAmount ?? null),
      validFrom: header.validFrom ?? null,
      validUntil: header.validUntil ?? null,
      isFeatured: header.isFeatured ?? false,
      isVisibleWeb: header.isVisibleWeb ?? false,
      usageLimit: header.usageLimit ?? null,
      notes: header.notes ?? null,
    })
    .where(eq(promotions.id, id))
    .returning({ id: promotions.id });
  if (updated.length === 0) return null;
  await escribirDestinos(db, id, destinos);
  await escribirPagos(db, id, pagos);
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

export async function deletePromotionPermanently(db: Db, id: string) {
  await db.delete(promotionTarget).where(eq(promotionTarget.promotionId, id));
  await db.delete(promotionService).where(eq(promotionService.promotionId, id));
  const result = await db.delete(promotions).where(eq(promotions.id, id)).returning({ id: promotions.id });
  return result.length > 0;
}
