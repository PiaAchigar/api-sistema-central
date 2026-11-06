/** Tope para que la descripción de la compra (hasta 200) tenga lugar para " — pack de N". */
const LARGO_MAXIMO = 150;

/**
 * Cómo se llama una venta de zonas sueltas: es lo que se lee en la ficha y en
 * la agenda. Con muchas zonas corta y dice cuántas faltan. Pura, sin base.
 */
export function nombreDeZonasSueltas(nombres: readonly string[]): string {
  const prefijo = nombres.length === 1 ? "Zona: " : "Zonas: ";
  const completo = prefijo + nombres.join(" + ");
  if (completo.length <= LARGO_MAXIMO) return completo;

  let entran = nombres.length - 1;
  while (entran > 1) {
    const corto = `${prefijo}${nombres.slice(0, entran).join(" + ")} y ${nombres.length - entran} más`;
    if (corto.length <= LARGO_MAXIMO) return corto;
    entran -= 1;
  }
  return `${prefijo}${nombres.length} zonas`;
}
