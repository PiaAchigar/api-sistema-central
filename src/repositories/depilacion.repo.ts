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
  calcularPrecioPack,
  politicaDePack,
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
 * Mapea las 19 columnas planas (mismo shape en la fila de la base y en el
 * body de `PUT /config`, ver `ConfigInput` arriba) al `DepilationConfig`
 * anidado que espera `depilation-pricing.ts` (Task 2).
 *
 * Un solo mapeo para los dos casos: `leerConfig` lo usa sobre la fila ya
 * guardada, y la validación de no-inversión de `configBody` (ronda de fixes
 * 1, punto 1) lo usa sobre el body ANTES de guardar. Si hubiera dos mapeos
 * separados podrían desalinearse — el que valida no sería el mismo que el
 * que después lee `leerConfig`, y la garantía de no-inversión dejaría de
 * cubrir lo que en verdad queda guardado.
 */
export function aConfigAnidada(input: ConfigInput): DepilationConfig {
  return {
    precioLista: { grande: input.priceGrande, mediana: input.priceMediana, chica: input.priceChica },
    minutosPrecio: {
      grande: input.pricingMinutesGrande,
      mediana: input.pricingMinutesMediana,
      chica: input.pricingMinutesChica,
    },
    tarifaEscalon1: input.tier1RatePerMinute,
    tarifaEscalon2: input.tier2RatePerMinute,
    minutosTurno: {
      mujer: {
        grande: input.slotMinutesFemaleGrande,
        mediana: input.slotMinutesFemaleMediana,
        chica: input.slotMinutesFemaleChica,
      },
      hombre: {
        grande: input.slotMinutesMaleGrande,
        mediana: input.slotMinutesMaleMediana,
        chica: input.slotMinutesMaleChica,
      },
    },
    redondeoTurno: input.slotRoundingStep,
    turnoMinimo: input.slotMinimumMinutes,
    packSesiones: input.packSessions,
    packDescuentoPct: input.packDiscountPercentage,
    packRedondeo: input.packRoundingBase,
  };
}

/**
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
  return aConfigAnidada(f);
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
  packSessions: number | null;
  packDiscountPercentage: number | null;
  packRoundingBase: number | null;
  isPublishedWeb: boolean;
  displayOrder: number;
  isActive: boolean;
};

/** El pack de un combo, ya resuelto y calculado, listo para mostrar. */
export type PackDeCombo = {
  sesiones: number;
  descuentoPct: number;
  redondeo: number;
  /** `true` si el combo define el suyo; `false` si hereda el global. */
  propio: boolean;
  /** Total del pack, calculado sobre `precioFinal` — o sea que un pack fijo
   *  lo calcula sobre su precio de catálogo, no sobre el de la fórmula. */
  precio: number;
  /** Cuánto se ahorra contra pagar las sesiones sueltas. Un descuento de 0 lo
   *  deja en 0: es la señal de que ese pack dejó de ser un pack. */
  ahorro: number;
};

export type DepilationComboAssembled = {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  fixedPrice: number | null;
  fixedDurationMinutes: number | null;
  choiceZoneCount: number;
  packSessions: number | null;
  packDiscountPercentage: number | null;
  packRoundingBase: number | null;
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
  /** El pack ya resuelto y calculado. Se manda armado desde acá para que ni el
   *  dashboard ni la web tengan que rehacer la cuenta por su cuenta. */
  pack: PackDeCombo;
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

  // Las tres columnas van juntas (`ck_dc_pack_completo`), pero acá se exige
  // que estén las tres igual: si por lo que fuera llegara media política, es
  // más seguro caer en la global que inventar el número que falta.
  const propia =
    combo.packSessions != null &&
    combo.packDiscountPercentage != null &&
    combo.packRoundingBase != null
      ? {
          sesiones: combo.packSessions,
          descuentoPct: combo.packDiscountPercentage,
          redondeo: combo.packRoundingBase,
        }
      : null;
  const politica = politicaDePack(config, propia);
  // Sobre `precioFinal`, no sobre `precioCalculado`: el pack de un pack fijo
  // se cobra sobre su precio de catálogo, que es lo que la clienta paga.
  const precioPack = calcularPrecioPack(precioFinal, config, propia);

  return {
    id: combo.id,
    name: combo.name,
    description: combo.description,
    kind: combo.kind,
    fixedPrice,
    fixedDurationMinutes: combo.fixedDurationMinutes,
    choiceZoneCount: combo.choiceZoneCount,
    packSessions: combo.packSessions,
    packDiscountPercentage: combo.packDiscountPercentage,
    packRoundingBase: combo.packRoundingBase,
    isPublishedWeb: combo.isPublishedWeb,
    displayOrder: combo.displayOrder,
    isActive: combo.isActive,
    zonas: zonasReales.map((z) => ({ id: z.id, name: z.nombre, category: z.categoria })),
    precioCalculado,
    precioFinal,
    duracionMinutos,
    pack: {
      ...politica,
      propio: propia !== null,
      precio: precioPack,
      ahorro: precioFinal * politica.sesiones - precioPack,
    },
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
  packSessions: depilationCombo.packSessions,
  packDiscountPercentage: depilationCombo.packDiscountPercentage,
  packRoundingBase: depilationCombo.packRoundingBase,
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
  /** Pack propio del combo. Las tres o ninguna — `ck_dc_pack_completo` en la
   *  base, y `comboDepilacionBody` en la ruta para dar un mensaje entendible
   *  en vez de un 500. Ausentes = usa la política global. */
  packSessions?: number | null;
  packDiscountPercentage?: number | null;
  packRoundingBase?: number | null;
};

export type ComboKindYPrecio = { kind: string; fixedPrice: string | number | null };

/**
 * Ronda de fixes 2, punto 5 (Minor): lectura liviana (solo `kind` y
 * `fixedPrice`, sin zonas ni config) para que `PATCH /combos/:id` pueda
 * comparar el `kind` guardado contra el del body ANTES de escribir. El hook
 * del front (`useGuardarComboDepilacion`) siempre manda `kind: "guardado"`
 * sin `fixedPrice` — sobre un combo que hoy es `pack_fijo` eso pasa el
 * schema igual (un "guardado" sin precio es válido en sí mismo) y
 * `actualizarCombo` lo escribía tal cual, convirtiendo un pack sembrado en
 * un guardado y borrándole el precio. Por la interfaz no se llega (el botón
 * Editar está oculto para los packs fijos), pero por API un rol con solo
 * `edit` sí podía.
 */
export async function obtenerKindYPrecioDeCombo(
  db: Db,
  id: string,
): Promise<ComboKindYPrecio | null> {
  const [row] = await db
    .select({ kind: depilationCombo.kind, fixedPrice: depilationCombo.fixedPrice })
    .from(depilationCombo)
    .where(eq(depilationCombo.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * `ux_depilation_combo_name` es UNIQUE (name) sobre TODA la tabla (no parcial
 * por is_active, a diferencia de `body_zone`): un combo archivado sigue
 * ocupando su nombre. Sin este chequeo, crear/editar con un nombre repetido
 * rompe el INSERT/UPDATE con un 500 genérico en vez del 409 que ya usan las
 * zonas — mismo agujero que se cerró para `body_zone` en la ronda anterior.
 */
export async function existeComboConNombre(
  db: Db,
  nombre: string,
  excludeId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: depilationCombo.id })
    .from(depilationCombo)
    .where(eq(depilationCombo.name, nombre));
  return rows.some((r) => r.id !== excludeId);
}

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
        packSessions: input.packSessions ?? null,
        packDiscountPercentage: input.packDiscountPercentage ?? null,
        packRoundingBase: input.packRoundingBase ?? null,
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
        packSessions: input.packSessions ?? null,
        packDiscountPercentage: input.packDiscountPercentage ?? null,
        packRoundingBase: input.packRoundingBase ?? null,
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

// ── Borrado real (hard-delete) ───────────────────────────────────────────
// Separado de archivar: archivar deja la fila viva con `is_active = false` y
// se puede revertir; esto la saca de la base. Mismo contrato que
// `getServiceDeleteImpact` / `hardDeleteService` en services.repo.ts —
// `ResourceManager` en el front consume esa forma ({ blocked, blockReason,
// cascade }) para pintar la confirmación, así que no conviene inventarle otra.

export type DeleteImpact = {
  blocked: boolean;
  blockReason?: string;
  cascade: Record<string, number>;
};

/**
 * Una zona incluida en algún combo NO se puede borrar: el combo quedaría con
 * menos zonas de las que dice vender y su precio cambiaría solo, sin que
 * nadie lo haya editado. Archivarla sí está permitido (el combo la sigue
 * mostrando). Las exclusiones, en cambio, se van en cascada: son pares que
 * sin la zona no significan nada.
 */
export async function getZonaDeleteImpact(db: Db, id: string): Promise<DeleteImpact> {
  const [enCombos, exclusiones] = await Promise.all([
    db
      .select({ comboId: depilationComboZone.comboId })
      .from(depilationComboZone)
      .where(eq(depilationComboZone.zoneId, id)),
    db
      .select({ id: zoneExclusion.id })
      .from(zoneExclusion)
      .where(or(eq(zoneExclusion.zoneId, id), eq(zoneExclusion.excludesZoneId, id))),
  ]);

  return {
    blocked: enCombos.length > 0,
    blockReason:
      enCombos.length > 0
        ? `Está incluida en ${enCombos.length} combo(s). Sacala de esos combos o archivala en su lugar.`
        : undefined,
    cascade: { exclusions: exclusiones.length },
  };
}

/** Borra la zona. Sus exclusiones se van solas: las DOS claves foráneas de
 *  `zone_exclusion` (`zone_id` y `excludes_zone_id`) son ON DELETE CASCADE en
 *  la migración 1.35.0, así que ambas direcciones del par caen con la zona.
 *  Borrarlas a mano acá además sería código muerto disfrazado de garantía: un
 *  test que lo mutara seguiría pasando, porque quien limpia es la base.
 *
 *  El caller debe haber verificado que `getZonaDeleteImpact` no esté
 *  `blocked` antes de llamar esta función. */
export async function hardDeleteZona(db: Db, id: string): Promise<boolean> {
  const deleted = await db
    .delete(bodyZone)
    .where(eq(bodyZone.id, id))
    .returning({ id: bodyZone.id });
  return deleted.length > 0;
}

/**
 * Un combo de depilación no lo referencia nadie todavía (no hay turnos ni
 * facturas colgando de `depilation_combo`), así que borrarlo nunca queda
 * bloqueado. Se informa igual cuántas zonas se desvinculan para que la
 * confirmación diga algo concreto.
 */
export async function getComboDeleteImpact(db: Db, id: string): Promise<DeleteImpact> {
  const zonas = await db
    .select({ id: depilationComboZone.id })
    .from(depilationComboZone)
    .where(eq(depilationComboZone.comboId, id));

  return { blocked: false, cascade: { zonas: zonas.length } };
}

/** Borra el combo y sus zonas asociadas en una transacción. */
export async function hardDeleteCombo(db: Db, id: string): Promise<boolean> {
  const deleted = await db.transaction(async (tx) => {
    await tx.delete(depilationComboZone).where(eq(depilationComboZone.comboId, id));
    return tx
      .delete(depilationCombo)
      .where(eq(depilationCombo.id, id))
      .returning({ id: depilationCombo.id });
  });
  return deleted.length > 0;
}
