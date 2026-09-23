import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  customerPurchase,
  depilationCombo,
  promotionTarget,
  promotions,
  service,
  training,
} from "../db/schema";
import { precioDeServicio } from "../lib/combo-pricing";
import {
  type FilaDeDesglose,
  desgloseDeCombo,
  desgloseDeDepilacion,
} from "../lib/desglose-de-catalogo";
import type { Sexo } from "../lib/depilation-pricing";
import { comboDelQueSalenLosServicios } from "../lib/servicios-comprados";
import { todayLocal } from "../lib/time";
import type { ItemVendible, PromoVendible } from "../lib/cotizacion";
import type { CatalogoDelPaquete } from "../lib/cotizacion-de-paquete";
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
  lines: { serviceName: string | null; sessionsIncluded: number | null }[];
} & Record<string, unknown>;

/**
 * El precio de LISTA de un combo: lo que costaría sin el descuento.
 *
 * En un combo común es el subtotal de sus renglones. En un **pack** no: su
 * `finalAmount` es N vueltas con descuento, mientras que `servicesSubtotal`
 * es UNA sola vuelta. Comparar los dos daba una "lista" más barata que el
 * total, así que la pantalla de venta mostraba "Precio de lista $249.000" al
 * lado de "Total $598.000" —sin tachar, sin fila de descuento y sin ahorro—,
 * que es exactamente lo contrario de lo que pasa: el pack es más BARATO que
 * comprar las 3 sesiones sueltas.
 *
 * `packEffectiveSessions` y no `packSessions`: son las vueltas por las que
 * `conPrecioDePack` multiplicó de verdad. Cuando el área no tiene tarifario
 * esa función se va sin tocar el precio, y contar las declaradas inventaría
 * un ahorro que no existe.
 */
function precioDeListaDeCombo(c: ComboArmado): number {
  if (c.kind !== "pack") return c.servicesSubtotal;
  const vueltas = (c.packEffectiveSessions as number | null) ?? 1;
  const porVuelta = (c.packUnitAmount as number | null) ?? c.servicesSubtotal;
  return porVuelta * vueltas;
}

function comboVendible(c: ComboArmado): ItemVendible {
  return {
    origen: "combo",
    id: c.id as string,
    nombre: (c.name as string | null) ?? "Sin nombre",
    base: precioDeListaDeCombo(c),
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
  /** La descripción cargada en el catálogo. `null` si está vacía. */
  descripcion: string | null;
  /**
   * Qué trae este item, para poder decirlo antes de cobrar.
   *
   * Vacío en servicios y capacitaciones, que son una cosa sola y no tienen
   * qué desglosar. Viaja en el catálogo y no en una llamada aparte por clic:
   * el backend ya arma las líneas de cada combo y las zonas de cada pack para
   * calcular el precio, así que exponerlas no cuesta ninguna consulta nueva.
   */
  desglose: FilaDeDesglose[];
};

/** Lo que `aItemDeCatalogo` no puede sacar del `ItemVendible`. */
type ParaMostrar = { descripcion?: string | null; desglose?: FilaDeDesglose[] };

/** Una descripción vacía o en blanco es lo mismo que no tenerla: que el front
 *  no tenga que decidir si `""` se muestra. */
const texto = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

function aItemDeCatalogo(item: ItemVendible, mostrar: ParaMostrar = {}): ItemDeCatalogo {
  const comun = {
    descripcion: mostrar.descripcion ?? null,
    desglose: mostrar.desglose ?? [],
  };
  return item.origen === "combo"
    ? {
        ...item,
        ...comun,
        // Un pack de catálogo SÍ tiene sesiones; un combo común, no.
        packSesiones: item.packSesiones ?? null,
        // El descuento del pack ya está adentro de `conDescuento`, y volver a
        // mostrarlo como porcentaje suelto invitaría a aplicarlo dos veces.
        packDescuentoPct: null,
        precioDesde: item.conDescuento,
      }
    : {
        ...item,
        ...comun,
        packSesiones: item.politica.sesiones,
        packDescuentoPct: item.politica.descuentoPct,
        precioDesde: item.unitario,
      };
}

export async function listCatalogoVendible(db: Db) {
  const [genericos, depilacion, servicios, capacitaciones, config] = await Promise.all([
    // `includeInactive` para poder RESOLVER, no para mostrar: un pack que
    // repite un combo no tiene renglones propios, y si ese combo está
    // archivado no estaría en la lista y el pack se mostraría sin desglose.
    // Los inactivos se filtran igual antes de devolverlos (ver abajo).
    listCombos(db, { includeInactive: true }),
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

  // De dónde saca sus renglones cada combo, ya resuelto: un pack que repite
  // otro combo los tiene en el combo repetido, no en sí mismo.
  const lineasPorCombo = new Map<string, ComboArmado["lines"]>();
  for (const c of genericos) {
    const a = c as ComboArmado;
    lineasPorCombo.set(a.id as string, a.lines ?? []);
  }

  return {
    combos: genericos
      .filter((c) => (c as ComboArmado).isActive !== false)
      .map((c) => {
        const a = c as ComboArmado;
        const deDonde = comboDelQueSalenLosServicios(
          a.kind ?? null,
          (a.packOfComboId as string | null) ?? null,
          a.id as string,
        );
        return aItemDeCatalogo(comboVendible(a), {
          descripcion: texto(a.description),
          desglose: desgloseDeCombo(
            lineasPorCombo.get(deDonde) ?? [],
            a.kind === "pack" ? ((a.packSessions as number | null) ?? null) : null,
          ),
        });
      }),
    depilacion: depilacion
      .filter((c) => c.isActive)
      .map((c) =>
        aItemDeCatalogo(
          {
            origen: "depilacion",
            id: c.id,
            nombre: c.name,
            unitario: c.precioFinal,
            politica: { sesiones: c.pack.sesiones, descuentoPct: c.pack.descuentoPct, redondeo: c.pack.redondeo },
          },
          {
            descripcion: texto(c.description),
            desglose: desgloseDeDepilacion(c.zonas, c.choiceZoneCount),
          },
        ),
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
 *
 * `sexo` sólo lo usa depilación —es lo único que cobra distinto según a quién
 * se le vende—; los demás orígenes valen lo mismo para cualquiera, así que
 * `preciosDeListaDe` (que nunca llega a llamar esto para depilación) puede
 * seguir sin pasarlo y usar el default.
 */
export async function obtenerItemVendible(
  db: Db,
  origen: ItemVendible["origen"],
  id: string,
  sexo: Sexo = "mujer",
): Promise<ItemVendible | null> {
  if (origen === "combo") {
    const c = await getComboById(db, id);
    if (!c) return null;
    return comboVendible(c as ComboArmado);
  }

  if (origen === "depilacion") {
    const c = await obtenerCombo(db, id, sexo);
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
 * El precio de lista de cada cosa de un paquete, por id.
 *
 * Combo y servicio reutilizan `obtenerItemVendible`, el mismo camino por el
 * que se cotiza cualquier venta suelta: un combo sin precio o un servicio sin
 * precio de lista dan el mismo resultado acá que en la venta suelta.
 *
 * **`sexo` sin default, a propósito (Task 6).** Antes esta función leía
 * `depilation_combo.fixed_price` crudo, el mismo número para cualquiera. Un
 * paquete de promo reparte su precio único en proporción a esto, y ese
 * reparto es lo que decide cuánto se le acredita a la clienta si cancela: si
 * el pack de depilación pesa el precio de mujer, a un hombre el paquete le
 * sale más barato de lo que cuesta y, al cancelar, se le acredita de menos.
 * Un tercer parámetro CON default habría dejado el mismo agujero abierto en
 * el primer llamador nuevo que se lo olvidara — por eso ningún llamador
 * puede cotizar sin decir explícitamente para quién.
 *
 * **Depilación sigue siendo la excepción, pero ahora pasa por
 * `obtenerCombo`.** `obtenerCombo(db, id, sexo)` ya resuelve `precioFinal`
 * con la derivación de `precioDePackFijo` (Task 3/4) — un `pack_fijo` cobra
 * proporcional al tiempo de ESE sexo, un `guardado` no tiene con qué. Pero
 * `guardado` (zonas a elección, sin `fixed_price`: lo prohíbe
 * `ck_dc_precio_guardado`) sigue sin resolver precio ACÁ, a propósito: su
 * `precioFinal` cae a la fórmula sobre zonas, un número que la venta de un
 * paquete NUNCA usa (`lineasDeUnPaquete` en `compras.repo.ts` sólo vende un
 * `pack_fijo` con `fixed_price` cargado). Cotizar con la fórmula prometería
 * un precio que confirmar la compra después niega, y Laura se enteraría
 * recién con la clienta delante — por eso se filtra por `kind === "pack_fijo"`
 * antes de llamar a `obtenerCombo`, y un `guardado` queda sin precio, para
 * que `cotizarPaquete` lo rechace nombrándolo (spec §14 deja los packs de
 * zona a elección fuera de alcance: no se les inventa un precio nuevo).
 */
export async function preciosDeListaDe(
  db: Db,
  destinos: readonly { tipo: "servicio" | "combo" | "depilacion"; id: string }[],
  sexo: Sexo,
): Promise<CatalogoDelPaquete> {
  const precios = new Map<string, number>();
  // El nombre se guarda aunque el precio no resuelva: es JUSTO el caso que
  // `cotizarPaquete` tiene que nombrar al rechazar. Antes el error salía con
  // el UUID y Laura tenía que ir a la promo a adivinar cuál era.
  const nombres = new Map<string, string>();

  const idsDeDepilacion = destinos.filter((d) => d.tipo === "depilacion").map((d) => d.id);
  if (idsDeDepilacion.length > 0) {
    const filas = await db
      .select({
        id: depilationCombo.id,
        name: depilationCombo.name,
        kind: depilationCombo.kind,
        fixedPrice: depilationCombo.fixedPrice,
      })
      .from(depilationCombo)
      .where(inArray(depilationCombo.id, idsDeDepilacion));
    for (const f of filas) {
      if (f.name) nombres.set(f.id, f.name);
      // Un `guardado` no resuelve precio acá: ver el porqué en el docstring.
      if (f.kind !== "pack_fijo" || f.fixedPrice == null) continue;
      const combo = await obtenerCombo(db, f.id, sexo);
      if (!combo) continue;
      if (combo.precioFinal > 0) precios.set(f.id, combo.precioFinal);
    }
  }

  for (const d of destinos) {
    if (d.tipo === "depilacion") continue;
    const item = await obtenerItemVendible(db, d.tipo, d.id);
    if (!item) continue;
    nombres.set(d.id, item.nombre);
    const precio = item.origen === "combo" ? item.conDescuento : item.unitario;
    if (precio > 0) precios.set(d.id, precio);
  }

  return { precios, nombres };
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
      promotionType: promotions.promotionType,
      precioDelPaquete: promotions.precioDelPaquete,
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
        cantidad: promotionTarget.cantidad,
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
    const cantidad = d.cantidad ?? 1;
    if (d.serviceId) lista.push({ tipo: "servicio", id: d.serviceId, cantidad });
    else if (d.comboId) lista.push({ tipo: "combo", id: d.comboId, cantidad });
    else if (d.depilationComboId) lista.push({ tipo: "depilacion", id: d.depilationComboId, cantidad });
    destinosPorPromo.set(d.promotionId, lista);
  }
  const usosPorPromo = new Map(usos.map((u) => [u.promotionId ?? "", Number(u.usos)]));

  return vigentes
    .filter((p) => !promoAgotada(p.usageLimit, usosPorPromo.get(p.id) ?? 0))
    .map((p) => ({
      id: p.id,
      name: p.name,
      promotionType: p.promotionType ?? null,
      precioDelPaquete: num(p.precioDelPaquete),
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

/**
 * Por qué una promo no se puede vender, en criollo.
 *
 * `obtenerPromoVendible` devuelve `null` por tres motivos distintos —no
 * existe, se le pasó la fecha, se quedó sin cupo— y los tres decían "no está
 * vigente". El cupo es lo que trajo la 1.53.0 y es el motivo que más va a
 * aparecer: Laura pone límite 10, la venta 11 le habla de vigencia, mira las
 * fechas, están perfectas, y no entiende nada.
 *
 * Corre SÓLO en el camino de error, así que las dos consultas extra no le
 * cuestan nada a la venta que sale bien.
 */
export async function motivoPromoNoVendible(db: Db, id: string): Promise<string> {
  const [p] = await db
    .select({
      name: promotions.name,
      status: promotions.status,
      validFrom: promotions.validFrom,
      validUntil: promotions.validUntil,
      usageLimit: promotions.usageLimit,
    })
    .from(promotions)
    .where(eq(promotions.id, id))
    .limit(1);

  if (!p) return "Esa promoción ya no existe";
  const nombre = p.name ? `La promo "${p.name}"` : "Esa promoción";
  if (p.status !== "active") return `${nombre} está archivada`;

  const hoy = todayLocal();
  if (p.validFrom && p.validFrom > hoy) return `${nombre} recién arranca el ${p.validFrom}`;
  if (p.validUntil && p.validUntil < hoy) return `${nombre} venció el ${p.validUntil}`;

  const [usados] = await db
    .select({ usos: count() })
    .from(customerPurchase)
    .where(and(eq(customerPurchase.promotionId, id), isNull(customerPurchase.cancelledAt)));
  const usos = Number(usados?.usos ?? 0);
  if (promoAgotada(p.usageLimit, usos)) {
    return `${nombre} se agotó: ya se usó ${usos} de ${p.usageLimit} vez/veces. Cancelar una venta libera un uso.`;
  }

  // Ninguno de los motivos conocidos: algo cambió entre la lectura y esta
  // consulta. Mejor un mensaje vago que uno inventado.
  return `${nombre} no se puede aplicar en este momento`;
}
