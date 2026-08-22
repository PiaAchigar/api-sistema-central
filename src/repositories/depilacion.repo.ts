import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { bodyZone, depilationPricingConfig, zoneExclusion } from "../db/schema";
import type { Categoria, DepilationConfig } from "../lib/depilation-pricing";

// ── Zonas ────────────────────────────────────────────────────────────────

export type ZonaRow = {
  id: string;
  name: string;
  category: string;
  displayOrder: number;
  isActive: boolean;
};

export type ExclusionRow = { zoneId: string; excludesZoneId: string };

export type ZonaConExclusiones = ZonaRow & { exclusions: string[] };

const CATEGORIAS: Categoria[] = ["grande", "mediana", "chica"];

const zonaFields = {
  id: bodyZone.id,
  name: bodyZone.name,
  category: bodyZone.category,
  displayOrder: bodyZone.displayOrder,
  isActive: bodyZone.isActive,
};

/**
 * Agrupa las zonas por categoría y les adjunta el array de ids que excluyen.
 * Función pura: no toca la base, así se puede testear con un fixture chico
 * en vez de tener que levantar Postgres.
 */
export function agruparZonasPorCategoria(
  zonas: ZonaRow[],
  exclusiones: ExclusionRow[],
): Record<Categoria, ZonaConExclusiones[]> {
  const exclusionesPorZona = new Map<string, string[]>();
  for (const e of exclusiones) {
    const lista = exclusionesPorZona.get(e.zoneId) ?? [];
    lista.push(e.excludesZoneId);
    exclusionesPorZona.set(e.zoneId, lista);
  }

  const grupos: Record<Categoria, ZonaConExclusiones[]> = { grande: [], mediana: [], chica: [] };
  for (const zona of zonas) {
    if (!CATEGORIAS.includes(zona.category as Categoria)) continue;
    grupos[zona.category as Categoria].push({
      ...zona,
      exclusions: exclusionesPorZona.get(zona.id) ?? [],
    });
  }
  for (const cat of CATEGORIAS) {
    grupos[cat].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  }
  return grupos;
}

export async function listarExclusiones(db: Db): Promise<ExclusionRow[]> {
  return db
    .select({ zoneId: zoneExclusion.zoneId, excludesZoneId: zoneExclusion.excludesZoneId })
    .from(zoneExclusion);
}

/** GET /zonas: las 24 zonas agrupadas por categoría, cada una con sus exclusiones. */
export async function listarZonas(db: Db): Promise<Record<Categoria, ZonaConExclusiones[]>> {
  const [zonas, exclusiones] = await Promise.all([
    db
      .select(zonaFields)
      .from(bodyZone)
      .orderBy(asc(bodyZone.displayOrder), asc(bodyZone.name)),
    listarExclusiones(db),
  ]);
  return agruparZonasPorCategoria(zonas, exclusiones);
}

export async function obtenerZona(db: Db, id: string): Promise<ZonaRow | null> {
  const [zona] = await db.select(zonaFields).from(bodyZone).where(eq(bodyZone.id, id)).limit(1);
  return zona ?? null;
}

/**
 * Trae, de la lista de ids pedida, solo las que existen Y están activas.
 * Usado por `PUT /zonas/:id/exclusiones` para rechazar con un 400 (en vez
 * de dejar que el INSERT reviente la FK con un 500) cualquier id que no sea
 * una zona activa real.
 */
export async function obtenerZonasActivasPorId(
  db: Db,
  ids: string[],
): Promise<Map<string, ZonaRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select(zonaFields)
    .from(bodyZone)
    .where(and(inArray(bodyZone.id, ids), eq(bodyZone.isActive, true)));
  return new Map(rows.map((z) => [z.id, z]));
}

/**
 * `lower(name) = lower(...)` en memoria en vez de vía SQL a propósito: la
 * tabla tiene 24 filas (no crece por request de un cliente, solo la edita
 * el panel), y así la regla de "nombre repetido" queda como función pura
 * testeable sin Postgres — la misma razón por la que `comboBody` chequea
 * servicios repetidos en JS en vez de dejar que reviente el UNIQUE.
 */
export function nombreDeZonaEnUso(
  zonasActivas: { id: string; name: string }[],
  nombre: string,
  excludeId?: string,
): boolean {
  const buscado = nombre.trim().toLowerCase();
  return zonasActivas.some(
    (z) => z.id !== excludeId && z.name.trim().toLowerCase() === buscado,
  );
}

async function listarZonasActivas(db: Db) {
  return db
    .select({ id: bodyZone.id, name: bodyZone.name })
    .from(bodyZone)
    .where(eq(bodyZone.isActive, true));
}

export async function existeZonaActivaConNombre(
  db: Db,
  nombre: string,
  excludeId?: string,
): Promise<boolean> {
  return nombreDeZonaEnUso(await listarZonasActivas(db), nombre, excludeId);
}

export type ZonaInput = {
  name: string;
  category: Categoria;
  displayOrder?: number | null;
};

export async function crearZona(db: Db, input: ZonaInput) {
  const [created] = await db
    .insert(bodyZone)
    .values({
      name: input.name,
      category: input.category,
      displayOrder: input.displayOrder ?? 0,
      isActive: true,
    })
    .returning();
  return created;
}

export async function actualizarZona(db: Db, id: string, input: ZonaInput) {
  const [updated] = await db
    .update(bodyZone)
    .set({
      name: input.name,
      category: input.category,
      displayOrder: input.displayOrder ?? 0,
    })
    .where(eq(bodyZone.id, id))
    .returning();
  return updated ?? null;
}

export async function setEstadoZona(db: Db, id: string, isActive: boolean) {
  const [updated] = await db
    .update(bodyZone)
    .set({ isActive })
    .where(eq(bodyZone.id, id))
    .returning();
  return updated ?? null;
}

// ── Exclusiones ──────────────────────────────────────────────────────────

/**
 * Arma las filas de exclusión en las DOS direcciones del par: si `zonaId`
 * excluye a `otraId`, `otraId` también excluye a `zonaId`. Función pura.
 */
export function filasDeExclusion(zonaId: string, otras: string[]): ExclusionRow[] {
  return otras.flatMap((otraId) => [
    { zoneId: zonaId, excludesZoneId: otraId },
    { zoneId: otraId, excludesZoneId: zonaId },
  ]);
}

/**
 * Reemplaza el set de exclusiones de una zona. Borra TODAS las filas que
 * tocan a `zonaId` (como excluyente o como excluida) y vuelve a insertar
 * solo las de la selección actual, en las dos direcciones — así, si se saca
 * una zona de la lista, las dos filas del par viejo desaparecen (no solo
 * una).
 *
 * Todo dentro de `db.transaction`: si el INSERT fallara después del DELETE,
 * sin transacción la zona quedaría sin ninguna exclusión (ni la vieja ni la
 * nueva) hasta el próximo guardado exitoso. Es el mismo antipatrón de
 * `promotions.repo.ts` (DELETE + INSERT sin transacción) que el brief pide
 * no repetir.
 *
 * Precondición: el caller (la ruta) ya validó que `zonaId` existe y que
 * todos los ids de `otras` son zonas activas — acá no se vuelve a chequear
 * a propósito, para no duplicar ida y vuelta a la base.
 */
export async function guardarExclusiones(db: Db, zonaId: string, otras: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(zoneExclusion)
      .where(or(eq(zoneExclusion.zoneId, zonaId), eq(zoneExclusion.excludesZoneId, zonaId)));

    const filas = filasDeExclusion(zonaId, otras);
    if (filas.length > 0) {
      await tx.insert(zoneExclusion).values(filas);
    }
  });
}

// ── Config ───────────────────────────────────────────────────────────────

export type ConfigInput = {
  priceGrande: number;
  priceMediana: number;
  priceChica: number;
  pricingMinutesGrande: number;
  pricingMinutesMediana: number;
  pricingMinutesChica: number;
  tier1RatePerMinute: number;
  tier2RatePerMinute: number;
  slotMinutesFemaleGrande: number;
  slotMinutesFemaleMediana: number;
  slotMinutesFemaleChica: number;
  slotMinutesMaleGrande: number;
  slotMinutesMaleMediana: number;
  slotMinutesMaleChica: number;
  slotRoundingStep: number;
  slotMinimumMinutes: number;
  packSessions: number;
  packDiscountPercentage: number;
  packRoundingBase: number;
};

/**
 * Mapea las 19 columnas planas de `depilation_pricing_config` al
 * `DepilationConfig` anidado que espera `depilation-pricing.ts` (Task 2).
 *
 * Falla ruidosamente si no hay fila: la config es singleton (siempre debería
 * existir una, sembrada por la migración 1.35.0), y devolver ceros/undefined
 * en su lugar dejaría que TODOS los precios del negocio salgan mal en
 * silencio en vez de que la pantalla explote con un error visible.
 *
 * Las columnas son `.notNull()` en el esquema Drizzle (reflejando los `NOT
 * NULL` reales de la migración 1.35.0), así que una vez que `f` existe, el
 * mapeo no necesita `!` ni chequeos extra: si algún día hay un NULL ahí, es
 * Postgres el que lo rechaza al escribir, no algo que este código deba
 * adivinar.
 */
export async function leerConfig(db: Db): Promise<DepilationConfig> {
  const [f] = await db.select().from(depilationPricingConfig).limit(1);
  if (!f) throw new Error("Falta la fila de depilation_pricing_config");
  return {
    precioLista: { grande: f.priceGrande, mediana: f.priceMediana, chica: f.priceChica },
    minutosPrecio: {
      grande: f.pricingMinutesGrande,
      mediana: f.pricingMinutesMediana,
      chica: f.pricingMinutesChica,
    },
    tarifaEscalon1: f.tier1RatePerMinute,
    tarifaEscalon2: f.tier2RatePerMinute,
    minutosTurno: {
      mujer: {
        grande: f.slotMinutesFemaleGrande,
        mediana: f.slotMinutesFemaleMediana,
        chica: f.slotMinutesFemaleChica,
      },
      hombre: {
        grande: f.slotMinutesMaleGrande,
        mediana: f.slotMinutesMaleMediana,
        chica: f.slotMinutesMaleChica,
      },
    },
    redondeoTurno: f.slotRoundingStep,
    turnoMinimo: f.slotMinimumMinutes,
    packSesiones: f.packSessions,
    packDescuentoPct: f.packDiscountPercentage,
    packRedondeo: f.packRoundingBase,
  };
}

/** Actualiza la fila única de config y devuelve el objeto anidado ya releído. */
export async function guardarConfig(db: Db, input: ConfigInput): Promise<DepilationConfig> {
  const updated = await db
    .update(depilationPricingConfig)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(depilationPricingConfig.singleton, true))
    .returning({ id: depilationPricingConfig.id });
  if (updated.length === 0) throw new Error("Falta la fila de depilation_pricing_config");
  return leerConfig(db);
}
