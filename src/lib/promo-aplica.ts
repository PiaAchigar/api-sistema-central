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
export type DestinoDePromo = { tipo: TipoDeDestino; id: string };

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

/** Las promos que sirven para lo elegido. Sin nada elegido, ninguna. */
export function promosQueAplican<P extends { destinos: readonly DestinoDePromo[] }>(
  promos: readonly P[],
  item: ItemElegido | null,
): P[] {
  if (!item) return [];
  return promos.filter((p) => promoAplica(p.destinos, item));
}
