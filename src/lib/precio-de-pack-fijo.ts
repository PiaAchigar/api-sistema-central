import {
  type DepilationConfig,
  type Sexo,
  type ZonaParaCotizar,
  calcularDuracionTurno,
} from "./depilation-pricing";

/** La zona "a elección" se cotiza y se agenda como una zona CHICA. Mismo valor
 *  que `CATEGORIA_ELECCION` en `depilacion.repo.ts`, repetido acá para que
 *  este archivo no dependa del repositorio. */
const CATEGORIA_DE_REGALO = "chica" as const;

function conZonasDeRegalo(
  zonas: readonly ZonaParaCotizar[],
  zonasAEleccion: number,
): ZonaParaCotizar[] {
  const fantasmas = Array.from({ length: Math.max(0, zonasAEleccion) }, (_, i) => ({
    id: `eleccion-${i}`,
    nombre: "Zona a elección",
    categoria: CATEGORIA_DE_REGALO,
  }));
  return [...zonas, ...fantasmas];
}

/**
 * Lo que sale un `pack_fijo` para una persona de este sexo.
 *
 * El precio de un pack fijo lo pone Laura a mano, así que no sale de ninguna
 * fórmula. **El de hombre se deriva de la relación de minutos de ESE pack**:
 * Laura carga un solo número y el sistema saca los dos, en vez de obligarla a
 * mantener dos precios que tarde o temprano se desincronizan.
 *
 * Con "Cuerpo Full" ($65.000, 60 min mujer / 75 hombre): 65.000 × 75/60 =
 * 81.250, redondeado con `packRedondeo` → $81.000.
 *
 * **Con `duracionFija` cargada no hay proporción de la que derivar**: el pack
 * dura lo mismo para los dos. Ahí el hombre paga lo mismo que la mujer.
 * Cobrarle más sería inventar plata, y dividir igual daría un número sin
 * sentido.
 */
export function precioDePackFijo(
  fixedPrice: number,
  zonas: readonly ZonaParaCotizar[],
  zonasAEleccion: number,
  duracionFija: number | null,
  sexo: Sexo,
  config: DepilationConfig,
): number {
  if (sexo === "mujer") return fixedPrice;
  if (duracionFija != null) return fixedPrice;

  const todas = conZonasDeRegalo(zonas, zonasAEleccion);
  const minutosMujer = calcularDuracionTurno(todas, "mujer", config);
  const minutosHombre = calcularDuracionTurno(todas, "hombre", config);

  // Un pack sin zonas no tiene relación: devolver lo cargado es lo único
  // honesto, y evita el 0/0.
  if (minutosMujer <= 0 || minutosHombre <= minutosMujer) return fixedPrice;

  const crudo = fixedPrice * (minutosHombre / minutosMujer);
  const base = Math.max(1, config.packRedondeo);
  return Math.round(crudo / base) * base;
}
