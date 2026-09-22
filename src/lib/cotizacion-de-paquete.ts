/** Lo mínimo que `cotizarPaquete` necesita de una promo. */
export type PromoParaCotizar = {
  id: string;
  name: string | null;
  promotionType: string | null;
  precioDelPaquete: number | null;
  destinos: readonly { tipo: "servicio" | "combo" | "depilacion"; id: string; cantidad: number }[];
};

/**
 * El catálogo resuelto de un paquete: qué vale cada parte y cómo se llama.
 *
 * Los nombres no son decorativos y por eso viajan JUNTO a los precios, en un
 * solo objeto, en vez de como un parámetro opcional aparte: el error de "esta
 * parte no tiene precio" tiene que nombrarla. Laura no puede hacer nada con
 * "No se pudo resolver el precio de: 0d3e1a7c-…" — tiene que ir a mirar la
 * promo y adivinar cuál de las cosas que tildó es esa. Si el nombre fuera
 * opcional, el día que alguien agregue un llamador nuevo y se lo olvide, el
 * mensaje vuelve a ser un UUID sin que nada avise.
 *
 * `nombres` tiene entrada para todo destino que EXISTA en el catálogo, tenga
 * precio o no — que es justamente el caso que hay que nombrar. `precios` sólo
 * para los que resuelven precio.
 */
export type CatalogoDelPaquete = {
  precios: ReadonlyMap<string, number>;
  nombres: ReadonlyMap<string, string>;
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

/** Los montos van a mensajes que lee Laura, no a un log. */
const pesos = (n: number) => n.toLocaleString("es-AR");

/**
 * Por qué NO vender este paquete a este precio. `null` = adelante.
 *
 * El `finalAmount` que manda la pantalla no sólo se congela: **es el número
 * que se reparte entre las líneas** (`lineasDeUnPaquete`). Si no coincide con
 * el precio que hoy tiene la promo, la pantalla está vieja — Laura le cambió
 * el precio al paquete en otra solapa, o quedó abierta desde antes.
 *
 * **Se rechaza en vez de pisar el número en silencio.** Pisarlo haría la
 * venta con un precio que Laura NO vio, y esconder la única señal de que la
 * pantalla se le quedó atrás. Con la clienta delante, "recargá y fijate el
 * precio" es mejor que cobrar otra cosa.
 *
 * Lógica pura, sin base de datos: la promo ya la releyó el que llama.
 */
export function razonParaNoVenderElPaquete(
  promo: { name: string | null; precioDelPaquete: number | null },
  finalAmount: number,
): string | null {
  if (promo.precioDelPaquete == null || promo.precioDelPaquete <= 0) {
    return `"${promo.name ?? "La promo"}" no tiene precio de paquete cargado`;
  }
  if (finalAmount !== promo.precioDelPaquete) {
    return (
      `"${promo.name ?? "La promo"}" sale $${pesos(promo.precioDelPaquete)} y se está ` +
      `intentando vender a $${pesos(finalAmount)}. La pantalla quedó vieja: recargá y ` +
      "volvé a cotizar antes de cobrar."
    );
  }
  return null;
}

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
  catalogo: CatalogoDelPaquete,
  _compradoEl: Date,
): CotizacionDePaquete {
  const { precios: preciosDeLista, nombres } = catalogo;
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
  //
  // Se rechaza NOMBRANDO la parte, que es lo que el readme y PENDIENTES.md
  // prometen y lo que ya hace la venta (`compras.repo.ts`). El id crudo queda
  // sólo para el destino que ni siquiera está en el catálogo —borrado después
  // de armar la promo—, donde no hay mejor nombre que dar.
  const sinPrecio = promo.destinos
    .filter((d) => !preciosDeLista.has(d.id))
    .map((d) => (nombres.get(d.id) ? `"${nombres.get(d.id)}"` : d.id));
  if (sinPrecio.length > 0) {
    throw new Error(`No se pudo resolver el precio de: ${sinPrecio.join(", ")}`);
  }

  const baseAmount = promo.destinos.reduce(
    (a, d) => a + preciosDeLista.get(d.id)! * Math.max(1, d.cantidad),
    0,
  );

  // Un paquete que sale MÁS que sus partes sueltas no es un paquete.
  //
  // Se avisa acá, al cotizar, y no recién al apretar Vender: hasta la
  // revisión final la cotización salía redonda y el `.refine` de `compraBody`
  // tiraba "Los montos tienen que ir de mayor a menor: base ≥ con descuento ≥
  // final" con la clienta delante — un mensaje sobre tres campos de un JSON
  // que Laura nunca vio, para un error que está en el precio que ella cargó.
  if (promo.precioDelPaquete > baseAmount) {
    throw new Error(
      `"${promo.name ?? "La promo"}" está cargada en $${pesos(promo.precioDelPaquete)}, ` +
        `pero lo que lleva adentro vale $${pesos(baseAmount)} de lista. Un paquete no puede ` +
        "salir más caro que comprar las cosas por separado: revisá el precio del paquete en la promo.",
    );
  }

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
