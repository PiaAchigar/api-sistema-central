import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { customerPurchase, promotionTarget, promotions, service, training } from "../db/schema";
import { precioDeServicio } from "../lib/combo-pricing";
import { todayLocal } from "../lib/time";
import type { ItemVendible, PromoVendible } from "../lib/cotizacion";
import type { DestinoDePromo } from "../lib/promo-aplica";
import { promoAgotada, promoEstaVigente } from "../lib/promo-vigente";
import { getComboById, listCombos } from "./combos.repo";
import { leerConfig, listarCombos, obtenerCombo } from "./depilacion.repo";

/**
 * El catálogo de lo que se puede vender, en una sola forma.
 *
 * Los tres orígenes viven en tablas distintas y con precios que se calculan
 * distinto; acá salen todos como `ItemVendible`, que es lo único que la
 * cotización necesita saber. La pantalla de venta no tiene que aprenderse el
 * catálogo: pide esto y muestra lo que venga.
 */

const num = (v: unknown) => (v == null ? null : Number(v));

/** `assembleCombo` recibe la cabecera como `Record<string, unknown>` y la
 *  desparrama, así que del otro lado los campos propios del combo llegan sin
 *  tipo. Esto los recupera en un solo lugar en vez de castear en cada uso. */
type ComboArmado = {
  servicesSubtotal: number;
  finalAmount: number;
  kind: string;
  packSessions: number | null;
} & Record<string, unknown>;

function comboVendible(c: ComboArmado): ItemVendible {
  return {
    origen: "combo",
    id: c.id as string,
    nombre: (c.name as string | null) ?? "Sin nombre",
    base: c.servicesSubtotal,
    // En un pack esto ya viene con el descuento del pack aplicado
    // (`conPrecioDePack`), así que la cotización no vuelve a multiplicar.
    conDescuento: c.finalAmount,
    validityMonths: (c.validityMonths as number | null) ?? null,
    // Sólo en un pack: las sesiones que se lleva la clienta (1.50.0).
    packSesiones: c.kind === "pack" ? ((c.packSessions as number | null) ?? null) : null,
  };
}

/** Un item con lo que hace falta para mostrarlo en una lista y elegirlo. */
export type ItemDeCatalogo = ItemVendible & {
  /** Sesiones que lleva el pack de este item, si es un pack. */
  packSesiones: number | null;
  /** El descuento de ese pack, para que la pantalla pueda decirlo. */
  packDescuentoPct: number | null;
  /** Precio de lista de la venta más común, para ordenar y mostrar. */
  precioDesde: number;
};

function aItemDeCatalogo(item: ItemVendible): ItemDeCatalogo {
  return item.origen === "combo"
    ? {
        ...item,
        // Un pack de catálogo SÍ tiene sesiones; un combo común, no.
        packSesiones: item.packSesiones ?? null,
        // El descuento del pack ya está adentro de `conDescuento`, y volver a
        // mostrarlo como porcentaje suelto invitaría a aplicarlo dos veces.
        packDescuentoPct: null,
        precioDesde: item.conDescuento,
      }
    : {
        ...item,
        packSesiones: item.politica.sesiones,
        packDescuentoPct: item.politica.descuentoPct,
        precioDesde: item.unitario,
      };
}

export async function listCatalogoVendible(db: Db) {
  const [genericos, depilacion, servicios, capacitaciones, config] = await Promise.all([
    listCombos(db),
    listarCombos(db),
    db
      .select({
        id: service.id,
        name: service.name,
        unitPriceList: service.unitPriceList,
        unitPriceCash: service.unitPriceCash,
      })
      .from(service)
      .where(eq(service.isActive, true))
      .orderBy(asc(service.name)),
    db
      .select({
        id: training.id,
        name: training.name,
        listPrice: training.listPrice,
        cashPrice: training.cashPrice,
        totalSessions: training.totalSessions,
      })
      .from(training)
      .where(eq(training.isActive, true))
      .orderBy(asc(training.name)),
    leerConfig(db),
  ]);

  const global = {
    sesiones: config.packSesiones,
    descuentoPct: config.packDescuentoPct,
    redondeo: config.packRedondeo,
  };

  return {
    combos: genericos
      .filter((c) => (c as ComboArmado).isActive !== false)
      .map((c) => aItemDeCatalogo(comboVendible(c as ComboArmado))),
    depilacion: depilacion
      .filter((c) => c.isActive)
      .map((c) =>
        aItemDeCatalogo({
          origen: "depilacion",
          id: c.id,
          nombre: c.name,
          unitario: c.precioFinal,
          politica: { sesiones: c.pack.sesiones, descuentoPct: c.pack.descuentoPct, redondeo: c.pack.redondeo },
        }),
      ),
    servicios: servicios.map((s) =>
      aItemDeCatalogo({
        origen: "servicio",
        id: s.id,
        nombre: s.name ?? "Sin nombre",
        unitario: precioDeServicio(s.unitPriceList, s.unitPriceCash),
        politica: global,
      }),
    ),
    // Una capacitación se vende ENTERA: `list_price` es el precio del curso
    // completo, no el de una clase. Por eso su "pack" es de 1 sesión — vender
    // media capacitación no existe.
    capacitaciones: capacitaciones.map((t) =>
      aItemDeCatalogo({
        origen: "capacitacion",
        id: t.id,
        nombre: t.name ?? "Sin nombre",
        unitario: precioDeServicio(t.listPrice, t.cashPrice),
        politica: { sesiones: 1, descuentoPct: 0, redondeo: 1 },
      }),
    ),
  };
}

/**
 * Un solo item, para cotizar sin traerse el catálogo entero.
 *
 * Devuelve `null` si no existe: el que llama decide si eso es un 404.
 */
export async function obtenerItemVendible(
  db: Db,
  origen: ItemVendible["origen"],
  id: string,
): Promise<ItemVendible | null> {
  if (origen === "combo") {
    const c = await getComboById(db, id);
    if (!c) return null;
    return comboVendible(c as ComboArmado);
  }

  if (origen === "depilacion") {
    const c = await obtenerCombo(db, id);
    if (!c) return null;
    return {
      origen: "depilacion",
      id: c.id,
      nombre: c.name,
      unitario: c.precioFinal,
      politica: {
        sesiones: c.pack.sesiones,
        descuentoPct: c.pack.descuentoPct,
        redondeo: c.pack.redondeo,
      },
    };
  }

  if (origen === "capacitacion") {
    const [t] = await db
      .select({
        id: training.id,
        name: training.name,
        listPrice: training.listPrice,
        cashPrice: training.cashPrice,
      })
      .from(training)
      .where(eq(training.id, id))
      .limit(1);
    if (!t) return null;
    return {
      origen: "capacitacion",
      id: t.id,
      nombre: t.name ?? "Sin nombre",
      unitario: precioDeServicio(t.listPrice, t.cashPrice),
      politica: { sesiones: 1, descuentoPct: 0, redondeo: 1 },
    };
  }

  const [s] = await db
    .select({
      id: service.id,
      name: service.name,
      unitPriceList: service.unitPriceList,
      unitPriceCash: service.unitPriceCash,
    })
    .from(service)
    .where(eq(service.id, id))
    .limit(1);
  if (!s) return null;

  const config = await leerConfig(db);
  return {
    origen: "servicio",
    id: s.id,
    nombre: s.name ?? "Sin nombre",
    unitario: precioDeServicio(s.unitPriceList, s.unitPriceCash),
    politica: {
      sesiones: config.packSesiones,
      descuentoPct: config.packDescuentoPct,
      redondeo: config.packRedondeo,
    },
  };
}

/**
 * Las promos que hoy se pueden aplicar a una venta.
 *
 * Filtra por vigencia (fecha LOCAL, no UTC: una promo que vence hoy no puede
 * desaparecer tres horas antes) y por cupo (contado en vivo sobre las ventas
 * no canceladas), y trae los destinos de cada una para que `promoAplica`
 * pueda decidir si sirve para lo que se está vendiendo.
 */
export async function listPromosVendibles(db: Db): Promise<PromoVendible[]> {
  const hoy = todayLocal();
  const filas = await db
    .select({
      id: promotions.id,
      name: promotions.name,
      discountPercentage: promotions.discountPercentage,
      discountAmount: promotions.discountAmount,
      validFrom: promotions.validFrom,
      validUntil: promotions.validUntil,
      usageLimit: promotions.usageLimit,
    })
    .from(promotions)
    .where(eq(promotions.status, "active"))
    .orderBy(asc(promotions.name));

  const vigentes = filas.filter((p) => promoEstaVigente(p, hoy));
  if (vigentes.length === 0) return [];
  const ids = vigentes.map((p) => p.id);

  const [destinos, usos] = await Promise.all([
    db
      .select({
        promotionId: promotionTarget.promotionId,
        serviceId: promotionTarget.serviceId,
        comboId: promotionTarget.comboId,
        depilationComboId: promotionTarget.depilationComboId,
      })
      .from(promotionTarget)
      .where(inArray(promotionTarget.promotionId, ids)),
    // Cupo usado: ventas no canceladas de cada promo.
    db
      .select({ promotionId: customerPurchase.promotionId, usos: count() })
      .from(customerPurchase)
      .where(and(inArray(customerPurchase.promotionId, ids), isNull(customerPurchase.cancelledAt)))
      .groupBy(customerPurchase.promotionId),
  ]);

  const destinosPorPromo = new Map<string, DestinoDePromo[]>();
  for (const d of destinos) {
    if (!d.promotionId) continue;
    const lista = destinosPorPromo.get(d.promotionId) ?? [];
    if (d.serviceId) lista.push({ tipo: "servicio", id: d.serviceId });
    else if (d.comboId) lista.push({ tipo: "combo", id: d.comboId });
    else if (d.depilationComboId) lista.push({ tipo: "depilacion", id: d.depilationComboId });
    destinosPorPromo.set(d.promotionId, lista);
  }
  const usosPorPromo = new Map(usos.map((u) => [u.promotionId ?? "", Number(u.usos)]));

  return vigentes
    .filter((p) => !promoAgotada(p.usageLimit, usosPorPromo.get(p.id) ?? 0))
    .map((p) => ({
      id: p.id,
      name: p.name,
      discountPercentage: num(p.discountPercentage),
      discountAmount: num(p.discountAmount),
      destinos: destinosPorPromo.get(p.id) ?? [],
    }));
}

/** Una promo por id, para cotizar. `null` si no existe o no está vigente. */
export async function obtenerPromoVendible(db: Db, id: string): Promise<PromoVendible | null> {
  const todas = await listPromosVendibles(db);
  return todas.find((p) => p.id === id) ?? null;
}
