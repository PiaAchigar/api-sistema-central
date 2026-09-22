import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  appointments,
  combos,
  customerPurchase,
  customerPurchaseService,
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

export type PromoDestinoInput = {
  tipo: TipoDeDestino;
  id: string;
  /**
   * Cuántas veces entra esta cosa en el paquete (1.55.0). Sólo significa algo
   * en las promos de tipo `paquete`; en las de descuento se fuerza a 1.
   */
  cantidad?: number;
};
export type PromoPagoInput = {
  serviceId: string;
  serviceProviderId: string;
  providerPayment: number;
};
export type PromoHeaderInput = {
  name: string;
  description?: string | null;
  /** 'percentage' | 'fixed_amount' | 'paquete' */
  promotionType?: string | null;
  discountPercentage?: number | null;
  discountAmount?: number | null;
  /** Obligatorio si `promotionType === "paquete"`. NULL en las de descuento. */
  precioDelPaquete?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
  isFeatured?: boolean | null;
  isVisibleWeb?: boolean | null;
  usageLimit?: number | null;
  notes?: string | null;
};

/** Las promos que se venden enteras, no como descuento sobre una cosa. */
export const TIPO_PAQUETE = "paquete";

const dec = (v: number | null | undefined) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

/**
 * Por qué esta promo no se puede guardar. Vacío = se puede.
 *
 * Va acá y no en un CHECK de la base porque el tipo y el precio se escriben en
 * la misma sentencia: un CHECK cruzado complicaría el update sin agregar
 * seguridad real (spec §4.1).
 */
export function razonesParaNoGuardarPromo(
  header: PromoHeaderInput,
  destinos: readonly PromoDestinoInput[],
): string[] {
  if (header.promotionType !== TIPO_PAQUETE) return [];
  const razones: string[] = [];
  if (header.precioDelPaquete == null || header.precioDelPaquete <= 0) {
    razones.push("una promo que se vende como paquete necesita un precio");
  }
  if (destinos.length === 0) {
    razones.push("un paquete tiene que llevar al menos una cosa adentro");
  }
  return razones;
}

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
  precioDelPaquete: promotions.precioDelPaquete,
};

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
      cantidad: promotionTarget.cantidad,
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
  type DestinoConNombre = {
    filaId: string;
    tipo: TipoDeDestino;
    id: string;
    nombre: string | null;
    cantidad: number;
  };
  return filas.flatMap((f): DestinoConNombre[] => {
    const cantidad = f.cantidad ?? 1;
    if (f.serviceId) return [{ filaId: f.id, tipo: "servicio", id: f.serviceId, nombre: f.serviceName, cantidad }];
    if (f.comboId) return [{ filaId: f.id, tipo: "combo", id: f.comboId, nombre: f.comboName, cantidad }];
    if (f.depilationComboId)
      return [
        { filaId: f.id, tipo: "depilacion", id: f.depilationComboId, nombre: f.depilationComboName, cantidad },
      ];
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

async function escribirDestinos(
  db: Db,
  promotionId: string,
  destinos: PromoDestinoInput[],
  promotionType: string | null | undefined,
) {
  await db.delete(promotionTarget).where(eq(promotionTarget.promotionId, promotionId));
  if (destinos.length === 0) return;
  // Sin deduplicar, ux_pt rechaza el lote entero y Laura pierde la promo por
  // haber tildado dos veces lo mismo.
  const unicos = [...new Map(destinos.map((d) => [`${d.tipo}:${d.id}`, d])).values()];
  const esPaquete = promotionType === TIPO_PAQUETE;
  await db.insert(promotionTarget).values(
    unicos.map((d) => ({
      promotionId,
      serviceId: d.tipo === "servicio" ? d.id : null,
      comboId: d.tipo === "combo" ? d.id : null,
      depilationComboId: d.tipo === "depilacion" ? d.id : null,
      bodyZoneId: null,
      // En una promo de descuento la cantidad no significa nada y se fuerza a
      // 1: "20% off sobre 3 limpiezas" no quiere decir nada.
      cantidad: esPaquete ? Math.max(1, Math.trunc(d.cantidad ?? 1)) : 1,
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
    out.push({
      ...p,
      precioDelPaquete: num(p.precioDelPaquete),
      destinos: await destinosDe(db, p.id),
      pagos: await pagosDe(db, p.id),
    });
  }
  return out;
}

export async function getPromotionById(db: Db, id: string) {
  const [p] = await db.select(promoFields).from(promotions).where(eq(promotions.id, id)).limit(1);
  if (!p) return null;
  return {
    ...p,
    precioDelPaquete: num(p.precioDelPaquete),
    destinos: await destinosDe(db, id),
    pagos: await pagosDe(db, id),
  };
}

export async function createPromotion(
  db: Db,
  header: PromoHeaderInput,
  destinos: PromoDestinoInput[],
  pagos: PromoPagoInput[],
) {
  const razones = razonesParaNoGuardarPromo(header, destinos);
  if (razones.length > 0) throw new Error(razones.join("; "));

  const [created] = await db
    .insert(promotions)
    .values({
      name: header.name,
      description: header.description ?? null,
      promotionType: header.promotionType ?? null,
      discountPercentage: dec(header.discountPercentage ?? null),
      discountAmount: dec(header.discountAmount ?? null),
      precioDelPaquete: header.precioDelPaquete == null ? null : String(header.precioDelPaquete),
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
  await escribirDestinos(db, created.id, destinos, header.promotionType);
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
  const razones = razonesParaNoGuardarPromo(header, destinos);
  if (razones.length > 0) throw new Error(razones.join("; "));

  const updated = await db
    .update(promotions)
    .set({
      name: header.name,
      description: header.description ?? null,
      promotionType: header.promotionType ?? null,
      discountPercentage: dec(header.discountPercentage ?? null),
      discountAmount: dec(header.discountAmount ?? null),
      precioDelPaquete: header.precioDelPaquete == null ? null : String(header.precioDelPaquete),
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
  await escribirDestinos(db, id, destinos, header.promotionType);
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

/**
 * Qué se lleva puesto borrar una promo para siempre.
 *
 * Nunca bloquea, y es deliberado: desde la 1.53.0 la FK de `customer_purchase`
 * es ON DELETE SET NULL y cada venta congeló su `promotion_name`, así que una
 * venta vieja sigue contando su historia sin la promo.
 *
 * Lo que sí hay que decir son las dos cosas que cambian en silencio:
 *
 * - **Las ventas quedan desenganchadas.** Conservan el nombre, pierden el
 *   vínculo.
 * - **Los pagos acordados se borran.** Y eso mueve plata hacia adelante: todo
 *   turno de esas ventas que todavía no se completó va a liquidarse por el
 *   acuerdo general en vez del pago negociado para la promo
 *   (`computeProviderEarning`). Sin este aviso, el botón promete que no hay
 *   nada colgando.
 *
 * `turnosAfectados` es ese último número, y es el que más duele: los turnos
 * que HOY cobrarían el pago de la promo y mañana no. Se cuenta con el mismo
 * match que usa `computeProviderEarning` —(promo, servicio, proveedora)— y
 * sólo sobre los turnos que todavía no congelaron su `provider_earning`
 * (`reserved`/`scheduled`). Un turno completado ya cobró: la plata está
 * congelada y borrar la promo no la mueve.
 */
export async function getPromotionDeleteImpact(db: Db, id: string) {
  const [ventas, pagos, turnos, paquetes] = await Promise.all([
    db
      .select({ id: customerPurchase.id })
      .from(customerPurchase)
      // Todas, canceladas incluidas: una cancelada también pierde el vínculo,
      // y contar sólo las vivas haría que el número no cierre con lo que Laura
      // ve en la ficha de la clienta.
      .where(eq(customerPurchase.promotionId, id)),
    db
      .select({ id: promotionService.id })
      .from(promotionService)
      .where(eq(promotionService.promotionId, id)),
    db
      .select({ id: appointments.id })
      .from(appointments)
      .innerJoin(customerPurchaseService, eq(customerPurchaseService.appointmentId, appointments.id))
      .innerJoin(
        customerPurchase,
        eq(customerPurchase.id, customerPurchaseService.customerPurchaseId),
      )
      .innerJoin(
        promotionService,
        and(
          eq(promotionService.promotionId, customerPurchase.promotionId),
          eq(promotionService.serviceId, appointments.serviceId),
          eq(promotionService.serviceProviderId, appointments.serviceProviderId),
        ),
      )
      .where(
        and(
          eq(customerPurchase.promotionId, id),
          isNull(customerPurchase.cancelledAt),
          inArray(appointments.status, ["reserved", "scheduled"]),
        ),
      ),
    db
      .select({ id: customerPurchase.id })
      .from(customerPurchase)
      .where(
        and(eq(customerPurchase.promotionId, id), eq(customerPurchase.esPaqueteDePromo, true)),
      ),
  ]);

  return {
    blocked: false,
    cascade: {
      ventasDesenganchadas: ventas.length,
      pagosAcordados: pagos.length,
      turnosAfectados: turnos.length,
      paquetesVendidos: paquetes.length,
    },
  };
}

export async function deletePromotionPermanently(db: Db, id: string) {
  await db.delete(promotionTarget).where(eq(promotionTarget.promotionId, id));
  await db.delete(promotionService).where(eq(promotionService.promotionId, id));
  const result = await db.delete(promotions).where(eq(promotions.id, id)).returning({ id: promotions.id });
  return result.length > 0;
}
