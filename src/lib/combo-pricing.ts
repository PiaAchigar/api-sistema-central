/** Una línea de combo con su precio unitario ya congelado. */
export type ComboPricedLine = {
  servicePrice: number;
  sessionsIncluded: number;
};

/** Subtotal = suma de (precio unitario × sesiones) de cada servicio incluido. */
export function computeComboSubtotal(lines: ComboPricedLine[]): number {
  return lines.reduce((acc, l) => acc + l.servicePrice * l.sessionsIncluded, 0);
}

/**
 * Precio final del combo. Nunca negativo.
 *
 * OJO — `fixed` acá NO significa lo mismo que el `fixed_amount` de las promos.
 * En una promo, `fixed_amount` es un descuento: se resta de lo que la clienta
 * compra (`pack-pricing.aplicarPromo`). En un combo, `fixed` es el precio
 * cerrado: el combo cuesta eso y el subtotal sólo sirve para mostrar cuánto se
 * ahorra. Son dos operaciones distintas y confundirlas es un error de plata,
 * así que el descuento de promo vive en su propio módulo y este no lo importa.
 *
 * Si falta el dato que el tipo de precio necesita, se devuelve el subtotal sin
 * tocar. Es preferible mostrar el precio de lista que un cero engañoso.
 */
export function computeComboFinalPrice(
  subtotal: number,
  priceType: string | null,
  fixedPrice: number | null,
  discountPercentage: number | null,
): number {
  if (priceType === "fixed" && fixedPrice != null) {
    return Math.max(0, fixedPrice);
  }
  if (priceType === "percentage" && discountPercentage != null) {
    return Math.max(0, subtotal - (subtotal * discountPercentage) / 100);
  }
  return subtotal;
}

/**
 * Precio unitario a usar para un servicio dentro de un combo.
 *
 * Se prefiere el precio de lista, pero **hay que caer al de efectivo cuando no
 * hay lista**: en producción 79 de 213 servicios activos tienen
 * `unit_price_list` en NULL y sólo `unit_price_cash` cargado. Sin este
 * respaldo, cualquier combo armado con esos servicios se congelaba en $0 y el
 * combo entero terminaba valiendo $0 —que fue exactamente lo que pasó con el
 * primer combo que se cargó en producción.
 */
export function precioDeServicio(
  unitPriceList: number | string | null | undefined,
  unitPriceCash: number | string | null | undefined,
): number {
  const elegido = unitPriceList ?? unitPriceCash;
  if (elegido == null) return 0;
  const n = Number(elegido);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Precio unitario en efectivo de un servicio dentro de un combo.
 *
 * Es el respaldo simétrico de `precioDeServicio`: se prefiere el efectivo, y si
 * el servicio no lo tiene se usa el de lista. Así un servicio que sólo tiene
 * uno de los dos precios aporta lo mismo a las dos columnas, y nunca un 0 que
 * abarate el combo en efectivo sin que nadie lo haya decidido.
 */
export function precioDeServicioEfectivo(
  unitPriceList: number | string | null | undefined,
  unitPriceCash: number | string | null | undefined,
): number {
  const elegido = unitPriceCash ?? unitPriceList;
  if (elegido == null) return 0;
  const n = Number(elegido);
  return Number.isFinite(n) ? n : 0;
}

/** $88.000 — miles con punto, sin decimales (es-AR). */
function pesos(n: number): string {
  return `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

/**
 * La regla "siempre menor": un combo o pack tiene que costar MENOS que la suma
 * de lo que incluye, o no es una oferta. Devuelve el motivo del rechazo, o null.
 *
 * ⚠️ Se espeja en `front-dashboard/src/lib/combo-pricing.ts` (Task 6): el mismo
 * texto y el mismo test.
 */
export function razonSiNoEsMenor(final: number, sumaDeLasPartes: number): string | null {
  if (final >= sumaDeLasPartes) {
    return `El precio final (${pesos(final)}) tiene que ser menor que la suma de lo que incluye (${pesos(sumaDeLasPartes)}).`;
  }
  return null;
}
