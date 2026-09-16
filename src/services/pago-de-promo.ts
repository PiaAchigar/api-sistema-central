/**
 * Cuánto se le congela a la proveedora cuando el turno se marca Realizado.
 *
 * Lógica pura, extraída de `computeProviderEarning` para poder testearla sin
 * base. La regla nueva de 1.53.0: si Laura acordó un pago especial para esta
 * proveedora en este servicio mientras está en promo, ese monto **pisa** al
 * acuerdo general.
 *
 * `providerRate` se devuelve como string, no como número: `provider_rate` es
 * una columna `decimal` (ver `appointments.provider_rate` y
 * `service_provider_service.rate` en `src/db/schema/agenda.ts`) y Drizzle no
 * la mapea a número — el código original ya escribía en esa columna el
 * string crudo que venía de la base. Acá `acuerdo.rate` entra como número
 * (para poder operar: por hora, por porcentaje) y se vuelve a formatear como
 * string con la misma escala (2) al devolverlo, para no cambiar lo que
 * termina persistido.
 */

export type AcuerdoDeProveedora = {
  paymentType: string;
  rate: number;
};

export type GananciaCongelada = {
  providerPaymentType?: string;
  providerRate?: string | null;
  providerEarning?: string;
};

export function gananciaDelTurno(
  /** Pago acordado en la promo. `null` = no hay; `0` SÍ es un pago. */
  pagoDePromo: number | null,
  acuerdo: AcuerdoDeProveedora | null,
  duracionMinutos: number,
  precioEfectivoDelServicio: number,
): GananciaCongelada {
  if (pagoDePromo != null) {
    return {
      providerPaymentType: "promo",
      providerRate: null,
      providerEarning: pagoDePromo.toFixed(2),
    };
  }

  if (!acuerdo) return {};

  let earning: number;
  switch (acuerdo.paymentType) {
    case "per_hour":
      earning = (acuerdo.rate * duracionMinutos) / 60;
      break;
    case "percentage":
      // El porcentaje se calcula SIEMPRE sobre el precio en efectivo.
      earning = (acuerdo.rate / 100) * precioEfectivoDelServicio;
      break;
    case "fixed_per_service":
      earning = acuerdo.rate;
      break;
    default:
      return {};
  }

  return {
    providerPaymentType: acuerdo.paymentType,
    providerRate: acuerdo.rate.toFixed(2),
    providerEarning: earning.toFixed(2),
  };
}
