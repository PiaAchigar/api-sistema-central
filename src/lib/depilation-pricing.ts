export type Categoria = "grande" | "mediana" | "chica";
export type Sexo = "mujer" | "hombre";

export type ZonaParaCotizar = { id: string; nombre: string; categoria: Categoria };

export type DepilationConfig = {
  precioLista: Record<Categoria, number>;
  minutosPrecio: Record<Categoria, number>;
  tarifaEscalon1: number;
  tarifaEscalon2: number;
  minutosTurno: Record<Sexo, Record<Categoria, number>>;
  redondeoTurno: number;
  turnoMinimo: number;
  packSesiones: number;
  packDescuentoPct: number;
  packRedondeo: number;
};

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
 * Precio de un combo de zonas (PDF §4).
 *
 * OJO — usa `minutosPrecio`, que es unisex (10/7/5). Los minutos que van a la
 * agenda son OTROS y dependen del sexo; están en `calcularDuracionTurno`. El
 * PDF los separa a propósito y confundirlos es un error de plata.
 */
export function calcularPrecioCombo(
  zonas: ZonaParaCotizar[],
  config: DepilationConfig,
): Cotizacion {
  // Orden estable: a igual categoría se respeta el orden de entrada, así el
  // desglose que ve la clienta es siempre el mismo para la misma selección.
  const ordenadas = zonas
    .map((zona, entrada) => ({ zona, entrada }))
    .sort((a, b) =>
      RANGO[b.zona.categoria] - RANGO[a.zona.categoria] || a.entrada - b.entrada,
    )
    .map((x) => x.zona);

  const lineas = ordenadas.map((zona, i): LineaCotizacion => {
    const minutos = config.minutosPrecio[zona.categoria];
    const [importe, motivo]: [number, MotivoPrecio] =
      i === 0 ? [config.precioLista[zona.categoria], "lista"]
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
 * Precio del pack de N sesiones (PDF §7).
 *
 * Se redondea UNA SOLA VEZ, al final. El PDF lo marca en mayúsculas: si se
 * redondea el descuento o cada sesión por separado, los números no cierran.
 */
export function calcularPrecioPack(totalCombo: number, config: DepilationConfig): number {
  // Entero antes de dividir: `× 0,85` en coma flotante da 45900.000000000007.
  const bruto = (totalCombo * config.packSesiones * (100 - config.packDescuentoPct)) / 100;
  return Math.round(bruto / config.packRedondeo) * config.packRedondeo;
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
