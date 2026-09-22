/**
 * ¿Esta promo sirve para lo que se está vendiendo?
 *
 * Lógica pura, sin base de datos. Antes de 1.53.0 el desplegable de `Vender`
 * listaba TODAS las promos vigentes y le bajaba el precio a lo que fuera: se le
 * podía aplicar a un Baby Botox una promo pensada para depilación, sin que nada
 * avisara.
 */

export type TipoDeDestino = "servicio" | "combo" | "depilacion";

/** Una fila de `promotion_target`, ya resuelta a tipo + id. */
export type DestinoDePromo = {
  tipo: TipoDeDestino;
  id: string;
  /**
   * Cuántas veces entra en el paquete (1.55.0). En las promos de descuento es
   * siempre 1: ahí la lista dice SOBRE QUÉ se puede aplicar, no qué lleva.
   */
  cantidad: number;
};

/** Lo que la usuaria eligió vender: un `ItemVendible` del catálogo. */
export type ItemElegido = { origen: string; id: string };

/**
 * De qué tipo de destino habla un `origen` del catálogo vendible.
 *
 * `null` = ese origen no admite promo. Las capacitaciones son el caso real:
 * no hay columna de target para ellas.
 */
export function tipoDeOrigen(origen: string): TipoDeDestino | null {
  switch (origen) {
    // Combos y packs comparten origen a propósito: un pack ES una fila de
    // `combos`, y la diferencia está en los datos de esa fila.
    case "combo":
      return "combo";
    case "servicio":
      return "servicio";
    case "depilacion":
      return "depilacion";
    default:
      return null;
  }
}

/** Una promo aplica si alguno de sus destinos es exactamente lo elegido. */
export function promoAplica(
  destinos: readonly DestinoDePromo[],
  item: ItemElegido,
): boolean {
  const tipo = tipoDeOrigen(item.origen);
  if (tipo === null) return false;
  return destinos.some((d) => d.tipo === tipo && d.id === item.id);
}

/**
 * Por qué esta promo NO se puede aplicar a esta venta suelta. `null` = se puede.
 *
 * Son dos motivos y el segundo no lo veía nadie del lado del servidor
 * (revisión final de la 1.55.0):
 *
 * 1. **No aplica a lo elegido** — la promo de depilación sobre un Baby Botox.
 * 2. **Es una promo de PAQUETE.** Sus destinos SON los items que lleva, así
 *    que `promoAplica` matchea perfecto; pero un paquete no tiene
 *    `discount_percentage` ni `discount_amount`, así que `aplicarPromo` no
 *    baja ni un peso. La compra quedaba enganchada a la promo y **consumía un
 *    uso del cupo** sin haber vendido el paquete: la Promo Novia con límite 5
 *    se gastaba vendiendo sueltos. La única defensa era un `.filter()` del
 *    front (`VenderModal.tsx`), y una pantalla abierta hace media hora —o
 *    cualquier cosa que le pegue a la API— se la saltea.
 */
export function razonParaNoAplicarPromoSuelta(
  promo: { name: string | null; promotionType: string | null; destinos: readonly DestinoDePromo[] },
  item: ItemElegido,
): string | null {
  const nombre = promo.name ?? "";
  if (promo.promotionType === "paquete") {
    return (
      `La promo "${nombre}" se vende como un paquete entero, no como un descuento ` +
      "sobre una cosa suelta. Para venderla, elegí el paquete en vez del item."
    );
  }
  if (!promoAplica(promo.destinos, item)) {
    return `La promo "${nombre}" no aplica a lo que estás vendiendo`;
  }
  return null;
}

/** Las promos que sirven para lo elegido. Sin nada elegido, ninguna. */
export function promosQueAplican<P extends { destinos: readonly DestinoDePromo[] }>(
  promos: readonly P[],
  item: ItemElegido | null,
): P[] {
  if (!item) return [];
  return promos.filter((p) => promoAplica(p.destinos, item));
}
