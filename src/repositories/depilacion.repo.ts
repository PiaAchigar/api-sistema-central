import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  bodyZone,
  depilationCombo,
  depilationComboZone,
  depilationPricingConfig,
  zoneExclusion,
} from "../db/schema";
import {
  calcularDuracionTurno,
  calcularPrecioCombo,
  type Categoria,
  type DepilationConfig,
  type Exclusion,
  type PackFijo,
  type Sexo,
  type ZonaParaCotizar,
} from "../lib/depilation-pricing";

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

/** `listarExclusiones` habla en columnas (`zoneId`/`excludesZoneId`); el motor
 *  (Task 2) espera `{ zonaId, excluyeA }`. Función pura, un mapeo de nombres. */
export function exclusionesParaMotor(rows: ExclusionRow[]): Exclusion[] {
  return rows.map((r) => ({ zonaId: r.zoneId, excluyeA: r.excludesZoneId }));
}

/**
 * Detecta si la selección YA trae, las dos adentro, un par de zonas que se
 * pisan (ej. Pierna entera + Media pierna). Distinto de `zonasBloqueadas`
 * del motor (Task 2): esa función mira zonas FUERA de la selección, para que
 * la UI las deshabilite antes de que se puedan agregar. Acá el caso es que
 * las dos YA están adentro — algo que el frontend previene deshabilitando,
 * pero que el backend tiene que revalidar solo, porque nunca hay que confiar
 * en que el cliente respetó esa regla.
 */
export function conflictoEnSeleccion(
  seleccion: string[],
  exclusiones: Exclusion[],
): Exclusion | null {
  const set = new Set(seleccion);
  for (const e of exclusiones) {
    if (set.has(e.zonaId) && set.has(e.excluyeA)) return e;
  }
  return null;
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

// ── Packs fijos (para /cotizar) ─────────────────────────────────────────────

/**
 * Los packs fijos activos, con sus zonas base convertidas al `PackFijo` que
 * espera `buscarPackFijo` (Task 2). Solo `pack_fijo` puede "ganarle" a la
 * fórmula — un `guardado` nunca entra acá.
 */
export async function listarPacksFijos(db: Db): Promise<PackFijo[]> {
  const combos = await db
    .select({
      id: depilationCombo.id,
      name: depilationCombo.name,
      fixedPrice: depilationCombo.fixedPrice,
      fixedDurationMinutes: depilationCombo.fixedDurationMinutes,
      choiceZoneCount: depilationCombo.choiceZoneCount,
    })
    .from(depilationCombo)
    .where(and(eq(depilationCombo.kind, "pack_fijo"), eq(depilationCombo.isActive, true)));
  if (combos.length === 0) return [];

  const comboIds = combos.map((c) => c.id);
  const zoneRows = await db
    .select({ comboId: depilationComboZone.comboId, zoneId: depilationComboZone.zoneId })
    .from(depilationComboZone)
    .where(inArray(depilationComboZone.comboId, comboIds));
  const zonasPorCombo = new Map<string, string[]>();
  for (const r of zoneRows) {
    const lista = zonasPorCombo.get(r.comboId) ?? [];
    lista.push(r.zoneId);
    zonasPorCombo.set(r.comboId, lista);
  }

  return combos.map((c) => ({
    id: c.id,
    nombre: c.name,
    zonasBase: zonasPorCombo.get(c.id) ?? [],
    zonasAEleccion: c.choiceZoneCount,
    precioFijo: Number(c.fixedPrice),
    duracionFija: c.fixedDurationMinutes,
  }));
}

// ── Combos (Solapa Combos: guardado y CRUD de packs) ────────────────────────

/**
 * Categoría con la que se simulan las zonas "a elección" que un pack fijo
 * todavía no tiene resueltas (ver diseño §4.7). Se usa SOLO para calcular
 * `precioCalculado` en el catálogo (sin una clienta concreta eligiendo, no
 * hay zona real que sumar): "chica" es la categoría más barata, así que el
 * invariante "el pack fijo es más barato que su fórmula" queda probado para
 * el peor caso posible — cualquier zona real que se elija en la práctica es
 * igual o más cara, nunca más barata, así que la fórmula real nunca baja de
 * este número.
 */
const CATEGORIA_ELECCION: Categoria = "chica";

/**
 * Sexo usado para mostrar `duracionMinutos` en el catálogo de combos (GET
 * /combos), donde no hay una clienta concreta todavía. Es solo para
 * referencia en la pantalla de administración — la duración que de verdad se
 * bloquea en la agenda siempre sale de `/cotizar` con el sexo real.
 */
const SEXO_DURACION_CATALOGO: Sexo = "mujer";

/**
 * Precio de referencia de un combo para el catálogo (PDF §6 / diseño §4.7):
 * la fórmula sobre sus zonas fijas más `zonasAEleccion` zonas fantasma de la
 * categoría más barata. Función pura, testeable sin base.
 */
export function precioFormulaDeCombo(
  zonasFijas: ZonaParaCotizar[],
  zonasAEleccion: number,
  config: DepilationConfig,
): number {
  const fantasmas: ZonaParaCotizar[] = Array.from({ length: zonasAEleccion }, (_, i) => ({
    id: `eleccion-${i}`,
    nombre: "Zona a elección",
    categoria: CATEGORIA_ELECCION,
  }));
  return calcularPrecioCombo([...zonasFijas, ...fantasmas], config).total;
}

export type DepilationComboRow = {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  fixedPrice: string | number | null;
  fixedDurationMinutes: number | null;
  choiceZoneCount: number;
  isPublishedWeb: boolean;
  displayOrder: number;
  isActive: boolean;
};

export type DepilationComboAssembled = {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  fixedPrice: number | null;
  fixedDurationMinutes: number | null;
  choiceZoneCount: number;
  isPublishedWeb: boolean;
  displayOrder: number;
  isActive: boolean;
  zonas: { id: string; name: string; category: Categoria }[];
  /** La fórmula, siempre — nunca un precio guardado. */
  precioCalculado: number;
  /** El fijo si es `pack_fijo`, si no el calculado. Nunca lee `fixedPrice`
   *  para un `guardado`: esa es toda la razón de ser del diseño. */
  precioFinal: number;
  duracionMinutos: number;
};

/**
 * Arma la vista completa de un combo: precioCalculado (fórmula, siempre),
 * precioFinal (el fijo solo si es pack_fijo) y duracionMinutos. Función pura:
 * recibe las zonas reales ya resueltas y la config, no toca la base.
 */
export function assembleDepilationCombo(
  combo: DepilationComboRow,
  zonasReales: ZonaParaCotizar[],
  config: DepilationConfig,
): DepilationComboAssembled {
  const fixedPrice = combo.fixedPrice == null ? null : Number(combo.fixedPrice);
  const precioCalculado = precioFormulaDeCombo(zonasReales, combo.choiceZoneCount, config);
  // Nunca leer `fixedPrice` para un `guardado`: el CHECK de la base ya lo
  // garantiza NULL, pero este `combo.kind === "pack_fijo"` es la barrera en
  // código — aunque `fixedPrice` viniera cargado por error, un `guardado`
  // jamás lo usaría como precio.
  const precioFinal = combo.kind === "pack_fijo" ? (fixedPrice ?? precioCalculado) : precioCalculado;
  const duracionMinutos =
    combo.fixedDurationMinutes ?? calcularDuracionTurno(zonasReales, SEXO_DURACION_CATALOGO, config);

  return {
    id: combo.id,
    name: combo.name,
    description: combo.description,
    kind: combo.kind,
    fixedPrice,
    fixedDurationMinutes: combo.fixedDurationMinutes,
    choiceZoneCount: combo.choiceZoneCount,
    isPublishedWeb: combo.isPublishedWeb,
    displayOrder: combo.displayOrder,
    isActive: combo.isActive,
    zonas: zonasReales.map((z) => ({ id: z.id, name: z.nombre, category: z.categoria })),
    precioCalculado,
    precioFinal,
    duracionMinutos,
  };
}

const comboFields = {
  id: depilationCombo.id,
  name: depilationCombo.name,
  description: depilationCombo.description,
  kind: depilationCombo.kind,
  fixedPrice: depilationCombo.fixedPrice,
  fixedDurationMinutes: depilationCombo.fixedDurationMinutes,
  choiceZoneCount: depilationCombo.choiceZoneCount,
  isPublishedWeb: depilationCombo.isPublishedWeb,
  displayOrder: depilationCombo.displayOrder,
  isActive: depilationCombo.isActive,
};

async function zonasDelCombo(db: Db, comboId: string): Promise<ZonaParaCotizar[]> {
  const rows = await db
    .select({ id: bodyZone.id, name: bodyZone.name, category: bodyZone.category })
    .from(depilationComboZone)
    .innerJoin(bodyZone, eq(depilationComboZone.zoneId, bodyZone.id))
    .where(eq(depilationComboZone.comboId, comboId));
  return rows.map((r) => ({ id: r.id, nombre: r.name, categoria: r.category as Categoria }));
}

export async function listarCombos(db: Db): Promise<DepilationComboAssembled[]> {
  const [combos, config] = await Promise.all([
    db
      .select(comboFields)
      .from(depilationCombo)
      .orderBy(asc(depilationCombo.displayOrder), asc(depilationCombo.name)),
    leerConfig(db),
  ]);
  const out: DepilationComboAssembled[] = [];
  for (const c of combos) out.push(assembleDepilationCombo(c, await zonasDelCombo(db, c.id), config));
  return out;
}

export async function obtenerCombo(db: Db, id: string): Promise<DepilationComboAssembled | null> {
  const [c] = await db.select(comboFields).from(depilationCombo).where(eq(depilationCombo.id, id)).limit(1);
  if (!c) return null;
  const config = await leerConfig(db);
  return assembleDepilationCombo(c, await zonasDelCombo(db, id), config);
}

export type DepilationComboInput = {
  name: string;
  description?: string | null;
  kind: "pack_fijo" | "guardado";
  fixedPrice?: number | null;
  fixedDurationMinutes?: number | null;
  choiceZoneCount?: number | null;
  isPublishedWeb?: boolean | null;
  displayOrder?: number | null;
  zonaIds: string[];
};

async function writeComboZonas(db: Db, comboId: string, zonaIds: string[]) {
  await db.delete(depilationComboZone).where(eq(depilationComboZone.comboId, comboId));
  if (zonaIds.length === 0) return;
  await db.insert(depilationComboZone).values(zonaIds.map((zoneId) => ({ comboId, zoneId })));
}

/**
 * DELETE + INSERT de las zonas en la misma transacción que el alta: mismo
 * motivo que `createCombo` en `combos.repo.ts` — sin transacción, si el
 * INSERT de zonas fallara después de crear la cabecera, el combo quedaría
 * activo y sin ninguna zona.
 */
export async function crearCombo(
  db: Db,
  input: DepilationComboInput,
): Promise<DepilationComboAssembled | null> {
  const createdId = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(depilationCombo)
      .values({
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        fixedPrice: input.fixedPrice == null ? null : String(input.fixedPrice),
        fixedDurationMinutes: input.fixedDurationMinutes ?? null,
        choiceZoneCount: input.choiceZoneCount ?? 0,
        isPublishedWeb: input.isPublishedWeb ?? false,
        displayOrder: input.displayOrder ?? 0,
        isActive: true,
      })
      .returning({ id: depilationCombo.id });
    if (!created) return null;
    await writeComboZonas(tx, created.id, input.zonaIds);
    return created.id;
  });
  if (!createdId) return null;
  return obtenerCombo(db, createdId);
}

/** Mismo motivo que `crearCombo`: DELETE + INSERT de zonas en una transacción. */
export async function actualizarCombo(
  db: Db,
  id: string,
  input: DepilationComboInput,
): Promise<DepilationComboAssembled | null> {
  const updatedId = await db.transaction(async (tx) => {
    const updated = await tx
      .update(depilationCombo)
      .set({
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        fixedPrice: input.fixedPrice == null ? null : String(input.fixedPrice),
        fixedDurationMinutes: input.fixedDurationMinutes ?? null,
        choiceZoneCount: input.choiceZoneCount ?? 0,
        isPublishedWeb: input.isPublishedWeb ?? false,
        displayOrder: input.displayOrder ?? 0,
        updatedAt: new Date(),
      })
      .where(eq(depilationCombo.id, id))
      .returning({ id: depilationCombo.id });
    if (updated.length === 0) return null;
    await writeComboZonas(tx, id, input.zonaIds);
    return updated[0]!.id;
  });
  if (!updatedId) return null;
  return obtenerCombo(db, updatedId);
}

export async function setEstadoCombo(
  db: Db,
  id: string,
  isActive: boolean,
): Promise<DepilationComboAssembled | null> {
  const rows = await db
    .update(depilationCombo)
    .set({ isActive })
    .where(eq(depilationCombo.id, id))
    .returning({ id: depilationCombo.id });
  if (rows.length === 0) return null;
  return obtenerCombo(db, id);
}
