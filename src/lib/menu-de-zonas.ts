import type { Categoria, DepilationConfig, Sexo } from "./depilation-pricing";

/** La zona "a elección" se presupuesta como CHICA. Mismo valor que
 *  `CATEGORIA_ELECCION` en `depilacion.repo.ts`. */
const CATEGORIA_DE_REGALO: Categoria = "chica";

export type ZonaDelPack = {
  id: string;
  nombre: string;
  categoria: Categoria;
  activa: boolean;
};

export type ZonaDelMenu = {
  id: string;
  nombre: string;
  categoria: Categoria;
  minutos: number;
  /** Viene del cupo "a elección" del pack, no de sus zonas cargadas. */
  esDeRegalo: boolean;
  disponible: boolean;
  /** Por qué no se puede elegir. `null` cuando sí se puede. */
  motivo: string | null;
};

/**
 * Qué zonas puede elegir Laura para esta sesión, y cuánto ocupa cada una.
 *
 * El menú son **las zonas del pack que la clienta compró**, más —si el pack
 * declara zonas "a elección"— las zonas CHICAS del catálogo que el pack no
 * trae ya.
 *
 * **Sólo chicas para el lugar de regalo**, y no es una restricción arbitraria:
 * el presupuesto de tiempo reservó esa zona como chica
 * (`CATEGORIA_ELECCION`), igual que el precio. Si acá se ofreciera una zona
 * grande, el turno quedaría corto 6 minutos y el atraso se acumularía todos
 * los días sin que nadie lo vea.
 */
export function armarMenu(
  zonasDelPack: readonly ZonaDelPack[],
  zonasDelCatalogo: readonly ZonaDelPack[],
  zonasAEleccion: number,
  sexo: Sexo,
  config: DepilationConfig,
): ZonaDelMenu[] {
  const minutosDe = (c: Categoria) => config.minutosTurno[sexo][c];

  const delPack: ZonaDelMenu[] = zonasDelPack.map((z) => ({
    id: z.id,
    nombre: z.nombre,
    categoria: z.categoria,
    minutos: minutosDe(z.categoria),
    esDeRegalo: false,
    disponible: z.activa,
    // Se muestra igual: la clienta la pagó. Esconderla le haría creer que el
    // pack trae menos de lo que trae.
    motivo: z.activa ? null : "Esta zona ya no está en el catálogo",
  }));

  if (zonasAEleccion <= 0) return delPack;

  const yaEstan = new Set(zonasDelPack.map((z) => z.id));
  const regalo: ZonaDelMenu[] = zonasDelCatalogo
    .filter((z) => z.activa && z.categoria === CATEGORIA_DE_REGALO && !yaEstan.has(z.id))
    .map((z) => ({
      id: z.id,
      nombre: z.nombre,
      categoria: z.categoria,
      minutos: minutosDe(z.categoria),
      esDeRegalo: true,
      disponible: true,
      motivo: null,
    }));

  return [...delPack, ...regalo];
}

/**
 * Cuántas de las zonas tildadas son de REGALO (salen del cupo "a elección"
 * del pack y no de lo que el pack trae cargado).
 *
 * El spec §7.2 dice "hasta N zonas a elección", y ese tope no lo aplicaba
 * nadie: el menú ofrecía todas las chicas activas y el servidor sólo miraba
 * el presupuesto de minutos. Con "Combo de Esenciales" (2 grandes + 3 chicas
 * + 1 a elección, 30 min) alcanzaba con tildar las 2 grandes y 4 chicas de
 * regalo —30 ≤ 30, pasa— para que la clienta se llevara 4 zonas de regalo en
 * vez de 1.
 */
export function regalosElegidos(
  menu: readonly ZonaDelMenu[],
  elegidas: readonly string[],
): number {
  const deRegalo = new Set(menu.filter((z) => z.esDeRegalo).map((z) => z.id));
  return elegidas.filter((id) => deRegalo.has(id)).length;
}

/**
 * Cuántos minutos ocupan las zonas tildadas.
 *
 * Los ids que no están en el menú se ignoran en vez de sumar `NaN`: una
 * pantalla vieja mandando un id que ya no existe tiene que dar un número
 * chico, no romper la creación del turno con un error de duración.
 */
export function minutosElegidos(
  menu: readonly ZonaDelMenu[],
  elegidas: readonly string[],
): number {
  const porId = new Map(menu.map((z) => [z.id, z.minutos]));
  return elegidas.reduce((total, id) => total + (porId.get(id) ?? 0), 0);
}
