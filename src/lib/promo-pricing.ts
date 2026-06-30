/** Aplica el descuento sobre el subtotal. Nunca devuelve negativo.
 *  `type` llega como string del input/zod; solo importan 'percentage' | 'fixed_amount'. */
export function applyDiscount(
  subtotal: number,
  type: string | null,
  percentage: number | null,
  amount: number | null,
): number {
  if (type === "percentage" && percentage != null) {
    return Math.max(0, subtotal - (subtotal * percentage) / 100);
  }
  if (type === "fixed_amount" && amount != null) {
    return Math.max(0, subtotal - amount);
  }
  return subtotal;
}

/** Margen de la empresa = total de la promo − suma de pagos a proveedoras (regla §4.10). */
export function computeMargin(finalAmount: number, providerPayments: number[]): number {
  return finalAmount - providerPayments.reduce((acc, n) => acc + n, 0);
}
