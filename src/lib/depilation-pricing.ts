export type Categoria = "grande" | "mediana" | "chica";
export type Sexo = "mujer" | "hombre";

export type ZonaParaCotizar = { id: string; nombre: string; categoria: Categoria };

export type DepilationConfig = {
  /**
   * Precio de lista de la PRIMERA zona, por sexo (1.56.0).
   *
   * Antes era uno solo para los dos. El tiempo siempre se bifurcó
   * (`minutosTurno`) y el precio no, así que un hombre ocupaba 8 minutos de
   * máquina pagando los 6 de una mujer — 25% menos de rendimiento por
   * minuto.
   */
  precioLista: Record<Sexo, Record<Categoria, number>>;
  /** Base del escalonado (2ª zona en adelante), por sexo (1.56.0). */
  minutosPrecio: Record<Sexo, Record<Categoria, number>>;
  tarifaEscalon1: number;
  tarifaEscalon2: number;
  minutosTurno: Record<Sexo, Record<Categoria, number>>;
  redondeoTurno: number;
  turnoMinimo: number;
  packSesiones: number;
  packDescuentoPct: number;
  packRedondeo: number;
};

/**
 * Los tres números que definen un pack de sesiones.
 *
 * Existen en dos lugares: en `DepilationConfig` como política del negocio (la
 * que usa toda cotización armada al vuelo) y, opcionalmente, en cada combo
 * guardado. Laura vende algunos combos en 3 sesiones y otros en 5, con
 * descuentos distintos, y eso no entra en una sola fila de configuración.
 */
// PackPolitica, politicaDePack y calcularPrecioPack se mudaron a
// `pack-pricing.ts`: dejaron de ser de depilación cuando los packs pasaron a
// existir para cualquier combo. Se re-exportan para no tocar a quien ya los
// importaba desde acá, y `calcularPrecioPack` conserva su nombre viejo.
export type { PackPolitica } from "./pack-pricing";
export { politicaDePack, precioPack as calcularPrecioPack } from "./pack-pricing";

export type MotivoPrecio = "lista" | "escalon_1" | "escalon_2";

export type LineaCotizacion = {
  zonaId: string;
  nombre: string;
  categoria: Categoria;
  posicion: number;
  importe: number;
  motivo: MotivoPrecio;
};

export type Cotizacion = { total: number; lineas: LineaCotizacion[] };

export type PackFijo = {
  id: string;
  nombre: string;
  zonasBase: string[];
  zonasAEleccion: number;
  precioFijo: number;
  duracionFija: number | null;
};

export type Exclusion = { zonaId: string; excluyeA: string };

/** Grande vale más que mediana y mediana más que chica. El orden define el
 *  precio: la zona más cara va a lista y las que se suman comparten el turno. */
const RANGO: Record<Categoria, number> = { grande: 3, mediana: 2, chica: 1 };

/**
 * Precio de un combo de zonas (PDF §4), por sexo.
 *
 * Las DOS familias de minutos siguen separadas y siguen siendo cosas
 * distintas: `minutosPrecio` es cuántos minutos "vale" una zona a efectos de
 * tarifa, y `minutosTurno` es cuánto tiempo de agenda ocupa. Desde la 1.56.0
 * las dos se bifurcan por sexo, pero confundirlas sigue siendo un error de
 * plata.
 */
export function calcularPrecioCombo(
  zonas: readonly ZonaParaCotizar[],
  sexo: Sexo,
  config: DepilationConfig,
): Cotizacion {
  const lista = config.precioLista[sexo];
  const minutosDe = config.minutosPrecio[sexo];

  // Orden estable: a igual categoría se respeta el orden de entrada, así el
  // desglose que ve la clienta es siempre el mismo para la misma selección.
  const ordenadas = zonas
    .map((zona, entrada) => ({ zona, entrada }))
    .sort((a, b) =>
      RANGO[b.zona.categoria] - RANGO[a.zona.categoria] || a.entrada - b.entrada,
    )
    .map((x) => x.zona);

  const lineas = ordenadas.map((zona, i): LineaCotizacion => {
    const minutos = minutosDe[zona.categoria];
    const [importe, motivo]: [number, MotivoPrecio] =
      i === 0 ? [lista[zona.categoria], "lista"]
      : i === 1 ? [minutos * config.tarifaEscalon1, "escalon_1"]
      : [minutos * config.tarifaEscalon2, "escalon_2"];
    return {
      zonaId: zona.id, nombre: zona.nombre, categoria: zona.categoria,
      posicion: i + 1, importe, motivo,
    };
  });

  return { total: lineas.reduce((acc, l) => acc + l.importe, 0), lineas };
}

/**
 * Minutos a bloquear en la agenda (PDF §8). Cálculo aparte del precio: acá
 * el sexo importa (al hombre le lleva más tiempo) y en el precio no.
 */
export function calcularDuracionTurno(
  zonas: ZonaParaCotizar[],
  sexo: Sexo,
  config: DepilationConfig,
): number {
  // Sin zonas no hay turno. Devolver el piso de 10 haría que la agenda
  // bloquee tiempo por una selección vacía.
  if (zonas.length === 0) return 0;
  const suma = zonas.reduce((acc, z) => acc + config.minutosTurno[sexo][z.categoria], 0);
  const redondeado = Math.round(suma / config.redondeoTurno) * config.redondeoTurno;
  return Math.max(config.turnoMinimo, redondeado);
}

/**
 * Busca un pack fijo que coincida con la selección (PDF §6).
 * Coincide si todas sus zonas base están y sobran exactamente las que el pack
 * deja "a elección".
 */
export function buscarPackFijo(seleccion: string[], packs: PackFijo[]): PackFijo | null {
  const set = new Set(seleccion);
  const candidatos = packs.filter(
    (p) => p.zonasBase.every((z) => set.has(z)) &&
           set.size === p.zonasBase.length + p.zonasAEleccion,
  );
  if (candidatos.length === 0) return null;
  // Si coinciden varios, gana el más barato: una ambigüedad de catálogo no
  // puede terminar en que la clienta pague de más.
  return candidatos.reduce((mejor, p) => (p.precioFijo < mejor.precioFijo ? p : mejor));
}

/** Devuelve zonaBloqueada → zona que la bloquea (PDF §9). */
export function zonasBloqueadas(
  seleccion: string[],
  exclusiones: Exclusion[],
): Map<string, string> {
  const set = new Set(seleccion);
  const bloqueadas = new Map<string, string>();
  for (const e of exclusiones) {
    if (set.has(e.zonaId) && !set.has(e.excluyeA)) bloqueadas.set(e.excluyeA, e.zonaId);
  }
  return bloqueadas;
}

export type ViolacionNoInversion = {
  categoriaAgregada: Categoria;
  antes: Record<Categoria, number>;
  totalAntes: number;
  totalDespues: number;
};

/**
 * Verifica la propiedad de no-inversión (PDF §1: "agregar una zona nunca baja
 * el precio") contra una config concreta — a diferencia del test de
 * `depilation-pricing.test.ts`, que la prueba al azar contra UNA config fija,
 * esto se corre sobre CUALQUIER config (la que el usuario está por guardar)
 * para que la garantía no dependa de que nadie vuelva a tipear los mismos 19
 * números del PDF.
 *
 * Exhaustivo, no al azar — y por eso no es flaky: `calcularPrecioCombo`
 * ordena las zonas por categoría antes de tarifar, así que el total depende
 * solo de CUÁNTAS zonas de cada categoría hay en la selección, nunca de
 * cuáles (el desempate por orden de entrada no cambia el precio, solo el
 * desglose). Recorrer todos los conteos (grande, mediana, chica) hasta
 * `maxPorCategoria` cubre TODO el espacio de selecciones posibles hasta ese
 * tamaño, no una muestra — 12 alcanza y sobra: la tabla de precios por
 * posición se vuelve constante a partir de la 3ª zona de una categoría
 * (siempre escalón 2), así que si hay una inversión, aparece con pocas zonas.
 *
 * Devuelve la primera violación que encuentra (para el mensaje de error) o
 * `null` si la config es segura.
 */
export function primeraViolacionNoInversion(
  config: DepilationConfig,
  maxPorCategoria = 12,
): ViolacionNoInversion | null {
  const zonaDe = (categoria: Categoria, i: number): ZonaParaCotizar => ({
    id: `${categoria}-${i}`,
    nombre: categoria,
    categoria,
  });
  const armar = (conteo: Record<Categoria, number>): ZonaParaCotizar[] => [
    ...Array.from({ length: conteo.grande }, (_, i) => zonaDe("grande", i)),
    ...Array.from({ length: conteo.mediana }, (_, i) => zonaDe("mediana", i)),
    ...Array.from({ length: conteo.chica }, (_, i) => zonaDe("chica", i)),
  ];

  for (let nG = 0; nG <= maxPorCategoria; nG++) {
    for (let nM = 0; nM <= maxPorCategoria; nM++) {
      for (let nC = 0; nC <= maxPorCategoria; nC++) {
        const antes: Record<Categoria, number> = { grande: nG, mediana: nM, chica: nC };
        // Fijo en "mujer" hasta que la Task 4 le pase el sexo real: es lo que
        // el sistema hacía antes de la 1.56.0, así que el comportamiento no
        // cambia.
        const totalAntes = calcularPrecioCombo(armar(antes), "mujer", config).total;
        for (const categoriaAgregada of ["grande", "mediana", "chica"] as const) {
          const despues = { ...antes, [categoriaAgregada]: antes[categoriaAgregada] + 1 };
          const totalDespues = calcularPrecioCombo(armar(despues), "mujer", config).total;
          if (totalDespues <= totalAntes) {
            return { categoriaAgregada, antes, totalAntes, totalDespues };
          }
        }
      }
    }
  }
  return null;
}
