/**
 * Motor de precios de packs y promos: las dos capas, en orden.
 *
 *   base_amount        precio unitario × sesiones, sin ningún descuento
 *   discounted_amount  capa 1 — el descuento del pack o del combo
 *   final_amount       capa 2 — la promo, encima del anterior
 *
 * Lógica pura, sin base de datos. Sale de `depilation-pricing.ts`, que la
 * re-exporta para no romper a quien ya la importaba: era de depilación sólo
 * porque hasta ahora los packs eran de depilación.
 *
 * ⚠️ ESTE ARCHIVO ESTÁ ESPEJADO en `front-dashboard/src/lib/pack-pricing.ts`,
 * byte a byte, igual que `depilation-pricing.ts`. Son repos separados, así que
 * NO hay forma de verificarlo en CI: al tocar uno hay que tocar el otro y
 * comparar los md5 a mano.
 */

export type PackPolitica = { sesiones: number; descuentoPct: number; redondeo: number };

/**
 * La política global. Se tipa por estructura y no como `DepilationConfig` para
 * que este archivo no dependa de depilación: cualquier config con estas tres
 * columnas sirve.
 */
export type PoliticaGlobal = {
  packSesiones: number;
  packDescuentoPct: number;
  packRedondeo: number;
};

/**
 * Qué pack corre: el propio del combo si lo tiene, la política global si no.
 *
 * `propia` viene de columnas nullables que van de a tres (o las tres cargadas,
 * o ninguna — lo garantiza un CHECK). Una cotización armada al vuelo no tiene
 * combo, así que siempre cae en la global.
 */
export function politicaDePack(
  config: PoliticaGlobal,
  propia?: PackPolitica | null,
): PackPolitica {
  return (
    propia ?? {
      sesiones: config.packSesiones,
      descuentoPct: config.packDescuentoPct,
      redondeo: config.packRedondeo,
    }
  );
}

/**
 * Cuántas sesiones del pack se cobran. El retoque (la última sesión de un pack
 * que lo marca, #36) se entrega pero NO se cobra: `sinCobrar` = 1. Siempre se
 * cobra al menos una, y un valor negativo no suma sesiones.
 */
export function sesionesCobradas(sesiones: number, sinCobrar = 0): number {
  return Math.max(1, sesiones - Math.max(0, sinCobrar));
}

/**
 * Capa 1 — precio del pack de N sesiones (PDF §7).
 *
 * Se redondea UNA SOLA VEZ, al final. El PDF lo marca en mayúsculas: si se
 * redondea el descuento o cada sesión por separado, los números no cierran.
 */
export function precioPack(
  totalCombo: number,
  config: PoliticaGlobal,
  propia?: PackPolitica | null,
  sesionesSinCobrar = 0,
): number {
  const pack = politicaDePack(config, propia);
  const cobradas = sesionesCobradas(pack.sesiones, sesionesSinCobrar);
  // Entero antes de dividir: `× 0,85` en coma flotante da 45900.000000000007.
  const bruto = (totalCombo * cobradas * (100 - pack.descuentoPct)) / 100;
  return Math.round(bruto / pack.redondeo) * pack.redondeo;
}

export type Promo = {
  discountPercentage?: number | null;
  discountAmount?: number | null;
};

/**
 * Capa 2 — la promo, encima del precio que dejó la capa 1.
 *
 * Redondea AL PESO, no a la base de redondeo del pack: el redondeo a $500 es
 * una política de cómo se muestran los precios de lista, y un 15% sobre un
 * precio de lista no tiene por qué volver a caer en un múltiplo de 500.
 *
 * Nunca deja el precio por debajo de cero: un descuento en pesos más grande
 * que el precio da 0, no un número negativo que después se cobraría al revés.
 */
export function aplicarPromo(precio: number, promo: Promo | null | undefined): number {
  if (!promo) return precio;
  if (promo.discountPercentage != null) {
    return Math.round((precio * (100 - promo.discountPercentage)) / 100);
  }
  if (promo.discountAmount != null) {
    return Math.max(0, precio - promo.discountAmount);
  }
  // Una promo sin ninguno de los dos descuentos no descuenta. Pasa con las 65
  // 'promotions' de producción, que son bundles sin precio.
  return precio;
}

export type CapaUno =
  | { forma: "formula"; config: PoliticaGlobal; propia?: PackPolitica | null }
  | { forma: "fijo"; precioFijo: number };

export type PrecioDeCompra = {
  baseAmount: number;
  discountedAmount: number;
  finalAmount: number;
};

/**
 * Las dos capas juntas, que es como se congela una venta.
 *
 * `precioUnitario` es lo que sale UNA sesión sin ningún descuento.
 *
 * La capa 1 tiene dos formas y NO se mezclan:
 *  - `formula` — el descuento se calcula (depilación, o combo por porcentaje).
 *  - `fijo`    — el precio está puesto a mano y `precioPack` no interviene.
 *
 * ⚠️ El error de plata más fácil acá es multiplicar dos veces las sesiones.
 * `precioPack` YA multiplica por dentro (`pack.sesiones`), así que recibe el
 * precio unitario, no la base. El spec (§5.2) dice
 * `precioPack(base_amount, politica)`; escrito así cobraría seis veces de más
 * con la política global. Sólo el precio fijo multiplica acá.
 *
 * Y por eso mismo, en la forma `formula` las sesiones tienen que ser las de la
 * política: la base usa las que le pasan y el descuento usa las de la
 * política. Si difieren, los dos números hablan de packs distintos y el
 * resultado es plata mal cobrada sin que nada avise. Se rechaza.
 */
export function precioDeCompra(
  precioUnitario: number,
  sesiones: number,
  capaUno: CapaUno,
  promo?: Promo | null,
): PrecioDeCompra {
  if (capaUno.forma === "formula") {
    const pack = politicaDePack(capaUno.config, capaUno.propia);
    if (pack.sesiones !== sesiones) {
      throw new Error(
        `El pack es de ${pack.sesiones} sesiones y se pidieron ${sesiones}. ` +
          "Con la fórmula, las sesiones las define la política del pack.",
      );
    }
  }

  const baseAmount = precioUnitario * sesiones;
  const discountedAmount =
    capaUno.forma === "fijo"
      ? capaUno.precioFijo * sesiones
      : precioPack(precioUnitario, capaUno.config, capaUno.propia);
  return {
    baseAmount,
    discountedAmount,
    finalAmount: aplicarPromo(discountedAmount, promo),
  };
}
