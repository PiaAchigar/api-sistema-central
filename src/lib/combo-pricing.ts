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
 * En una promo, `fixed_amount` es un descuento: se resta del subtotal. En un
 * combo, `fixed` es el precio cerrado: el combo cuesta eso y el subtotal sólo
 * sirve para mostrar cuánto se ahorra. Por eso este módulo existe aparte de
 * `promo-pricing.ts` en vez de compartir `applyDiscount`: son dos operaciones
 * distintas y confundirlas es un error de plata.
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
