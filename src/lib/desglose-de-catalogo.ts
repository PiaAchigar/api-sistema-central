/**
 * Qué trae cada cosa del catálogo, para poder decirlo al elegirla en Vender.
 *
 * Hasta ahora la pantalla de venta mostraba sólo el NOMBRE de lo elegido, y
 * con eso no alcanza: "Pack 1 - Prueba" y "Cuerpo Full" no dicen qué se lleva
 * la clienta. Laura tenía que salir del CRM, abrir el dashboard y buscar el
 * combo para saber qué estaba vendiendo.
 *
 * Lógica pura, sin base: el repositorio resuelve (líneas del combo, zonas del
 * pack), esto sólo las convierte en la lista que se muestra.
 */

/** Un renglón del desglose: "3 × Baby Botox". */
export type FilaDeDesglose = { nombre: string; cantidad: number };

/** Lo que se muestra cuando falta el nombre, en vez de un renglón en blanco. */
const SIN_NOMBRE = "(sin nombre)";

/**
 * Qué se lleva la clienta al comprar un combo o un pack.
 *
 * **Las cantidades son las que realmente se van a poder agendar**, no las del
 * renglón del catálogo. Un pack de 3 con un renglón de "Baby Botox × 1" crea
 * 3 filas agendables al venderse (`filasDeServicioComprado` repite las líneas
 * una vez por sesión), así que acá dice "3 × Baby Botox". Mostrar el "× 1" del
 * renglón sería mostrarle a Laura algo distinto de lo que la venta produce.
 *
 * @param lineas los renglones del combo del que SALEN los servicios — en un
 *   pack que repite otro combo, los del combo repetido. Resolver eso es del
 *   repositorio (`comboDelQueSalenLosServicios`): acá ya llegan resueltos.
 * @param packSesiones las sesiones del pack; `null` en un combo común.
 */
export function desgloseDeCombo(
  lineas: readonly { serviceName: string | null; sessionsIncluded: number | null }[],
  packSesiones: number | null,
): FilaDeDesglose[] {
  const vueltas = Math.max(1, packSesiones ?? 1);
  return lineas.map((l) => ({
    nombre: l.serviceName ?? SIN_NOMBRE,
    cantidad: Math.max(1, l.sessionsIncluded ?? 1) * vueltas,
  }));
}

/**
 * Qué zonas trae un pack de depilación.
 *
 * `choiceZoneCount` son zonas que se SUMAN a las cargadas, no un subconjunto
 * de ellas: `precioFormulaDeCombo` las agrega como zonas fantasma antes de
 * calcular el precio. Por eso salen como un renglón propio al final y no
 * cambian el conteo de las fijas — leerlo al revés le haría creer a Laura que
 * "Combo de Esenciales" trae 5 zonas cuando en realidad trae 6.
 */
export function desgloseDeDepilacion(
  zonas: readonly { name: string | null }[],
  zonasAEleccion: number,
): FilaDeDesglose[] {
  const filas: FilaDeDesglose[] = zonas.map((z) => ({
    nombre: z.name ?? SIN_NOMBRE,
    cantidad: 1,
  }));
  if (zonasAEleccion > 0) {
    filas.push({ nombre: "Zona a elección", cantidad: zonasAEleccion });
  }
  return filas;
}
