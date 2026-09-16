/**
 * Cuándo una promo se puede ofrecer: por fecha y por cupo.
 *
 * Lógica pura. Las fechas son strings `YYYY-MM-DD` en hora LOCAL del negocio,
 * no UTC: comparar en UTC hace que una promo que vence hoy desaparezca tres
 * horas antes de tiempo.
 */

export function promoEstaVigente(
  p: { validFrom: string | null; validUntil: string | null },
  hoy: string,
): boolean {
  if (p.validFrom && p.validFrom > hoy) return false;
  if (p.validUntil && p.validUntil < hoy) return false;
  return true;
}

/**
 * `usos` son las ventas de esta promo que NO están canceladas. Se cuenta en
 * vivo en vez de llevar un contador: un contador se desincroniza y no sabe
 * devolver el uso cuando se cancela una venta.
 */
export function promoAgotada(usageLimit: number | null, usos: number): boolean {
  if (usageLimit == null) return false;
  return usos >= usageLimit;
}
