/** Lo mínimo que `cotizarPaquete` necesita de una promo. */
export type PromoParaCotizar = {
  id: string;
  name: string | null;
  promotionType: string | null;
  precioDelPaquete: number | null;
  destinos: readonly { tipo: "servicio" | "combo" | "depilacion"; id: string; cantidad: number }[];
};

export type CotizacionDePaquete = {
  description: string;
  sessionsTotal: number;
  promotionId: string;
  expiresAt: Date | null;
  baseAmount: number;
  discountedAmount: number;
  finalAmount: number;
};

/**
 * Cuánto sale un paquete y cuánto valdría suelto.
 *
 * Devuelve la MISMA forma que `cotizar()`, a propósito: la pantalla de venta
 * manda de vuelta estos tres montos sin saber si cotizó un combo o un paquete.
 *
 * **`baseAmount` no es decorativo:** es lo que deja mostrar "valen $335.000 —
 * te los llevás por $250.000" sin que el navegador rehaga la cuenta con un
 * catálogo que puede estar viejo.
 *
 * **`sessionsTotal` es 1 siempre.** Un paquete es UNA compra, por más cosas
 * que lleve adentro, y eso es lo que hace que el cupo se cuente bien: la Promo
 * Novia con límite 5 se puede vender 5 veces (spec §11).
 */
export function cotizarPaquete(
  promo: PromoParaCotizar,
  preciosDeLista: ReadonlyMap<string, number>,
  _compradoEl: Date,
): CotizacionDePaquete {
  if (promo.promotionType !== "paquete") {
    throw new Error("Esta promo no se vende como paquete: es un descuento sobre una cosa");
  }
  if (promo.precioDelPaquete == null || promo.precioDelPaquete <= 0) {
    throw new Error(`"${promo.name ?? "La promo"}" no tiene precio de paquete cargado`);
  }
  if (promo.destinos.length === 0) {
    throw new Error(`"${promo.name ?? "La promo"}" no lleva nada adentro`);
  }

  // Toda parte tiene que tener precio conocido. Inventar un reparto sería
  // peor: la clienta cobraría cualquier cosa al cancelar (spec §5).
  const sinPrecio = promo.destinos.filter((d) => !preciosDeLista.has(d.id)).map((d) => d.id);
  if (sinPrecio.length > 0) {
    throw new Error(`No se pudo resolver el precio de: ${sinPrecio.join(", ")}`);
  }

  const baseAmount = promo.destinos.reduce(
    (a, d) => a + preciosDeLista.get(d.id)! * Math.max(1, d.cantidad),
    0,
  );

  return {
    description: promo.name ?? "Promo",
    sessionsTotal: 1,
    promotionId: promo.id,
    // El vencimiento de un paquete no sale del catálogo: las partes pueden
    // tener validez distinta. Se decide al vender, como en cualquier compra
    // sin vencimiento propio.
    expiresAt: null,
    baseAmount,
    discountedAmount: promo.precioDelPaquete,
    finalAmount: promo.precioDelPaquete,
  };
}
