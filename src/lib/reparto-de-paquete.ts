/**
 * Cuánto vale cada parte de un paquete que se vende a un precio fijo.
 *
 * **Por qué hace falta.** El paquete vale $250.000 y cada línea de
 * `customer_purchase_service` necesita SU parte, porque cancelar, acreditar y
 * devolver leen `price` de cada fila. Si las líneas fueran sin precio, el
 * reparto cae al "partes iguales" que ya existe, y un paquete con un combo de
 * $80.000 y un masaje de $25.000 acreditaría cualquier cosa (es el mismo bug
 * que arregló la 1.52.0 para los combos).
 *
 * **La regla.** Proporcional al precio de lista de cada parte, y **la última
 * parte absorbe el redondeo**, de modo que la suma dé exactamente el precio
 * del paquete. Esa invariante no es cosmética: si la suma de las partes no da
 * el total, la clienta cobra de menos o de más al cancelar.
 */
export function repartirPrecioDelPaquete(
  precioDelPaquete: number,
  preciosDeLista: readonly number[],
): number[] {
  if (preciosDeLista.length === 0) return [];
  if (preciosDeLista.length === 1) return [precioDelPaquete];

  const total = preciosDeLista.reduce((a, b) => a + b, 0);

  // Todas las partes en 0: no hay proporción posible. Repartir en partes
  // iguales es lo único honesto — dividir por cero daría NaN y las filas
  // quedarían sin precio, que es justamente lo que esto viene a evitar.
  const proporcion = (precio: number) =>
    total > 0 ? precio / total : 1 / preciosDeLista.length;

  const montos: number[] = [];
  for (let i = 0; i < preciosDeLista.length - 1; i++) {
    montos.push(Math.round(precioDelPaquete * proporcion(preciosDeLista[i]!)));
  }
  // La última no se calcula: es lo que falta. Por construcción, entonces, la
  // suma da exactamente el precio del paquete para CUALQUIER entrada.
  montos.push(precioDelPaquete - montos.reduce((a, b) => a + b, 0));
  return montos;
}
