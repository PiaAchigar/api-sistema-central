import {
  boolean,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at").$defaultFn(() => new Date());
const updatedAt = () =>
  timestamp("updated_at")
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());

// ── Depilación definitiva (Migración 1.35.0) ────────────────────────────────
// Catálogo de zonas del cuerpo, exclusiones, config de precio/duración y
// combos. Reemplaza las 26 filas de `service` que representaban zonas
// sueltas: acá el precio no se carga a mano por fila, se calcula con
// `depilation_pricing_config` según la categoría de tamaño de la zona.

// `category` clasifica la zona por tamaño (grande/mediana/chica), no por
// parte del cuerpo — es lo que determina el precio y la duración de sesión
// en `depilation_pricing_config`. El índice único es parcial (`WHERE
// is_active`) para poder desactivar una zona y volver a crear otra con el
// mismo nombre sin chocar con la fila archivada.
export const bodyZone = pgTable("body_zone", {
  id: id(),
  name: varchar("name", { length: 100 }).notNull(),
  category: varchar("category", { length: 10 }).notNull(), // grande | mediana | chica
  displayOrder: integer("display_order").notNull(),
  isActive: boolean("is_active").notNull(),
  createdAt: createdAt().notNull(),
  updatedAt: updatedAt().notNull(),
});

// Pares de zonas que no tiene sentido vender juntas porque una incluye a la
// otra (ej: Pierna entera excluye Media pierna). La migración carga las dos
// direcciones del par, así que alcanza con filtrar por `zone_id` en
// cualquiera de los dos sentidos sin tener que armar el OR a mano.
export const zoneExclusion = pgTable("zone_exclusion", {
  id: id(),
  zoneId: uuid("zone_id").notNull(),
  excludesZoneId: uuid("excludes_zone_id").notNull(),
});

// Fila única (CHECK + UNIQUE sobre `singleton`) porque estos parámetros son
// una sola política de negocio del salón, no algo que varíe por zona o por
// cliente — no hay "config de la zona X", hay una config y las zonas
// referencian su categoría contra ella.
//
// Hay DOS familias de minutos con propósitos distintos:
//   - `pricing_minutes_*` es la duración que se usa para CALCULAR EL PRECIO
//     (tarifa por minuto, PDF §3-4): cuántos minutos "vale" una sesión de
//     esa categoría.
//   - `slot_minutes_{female,male}_*` es la duración que se usa para RESERVAR
//     EL TURNO en la agenda, separada por sexo porque el tiempo real de
//     depilación en hombre y mujer difiere para la misma zona (vello más
//     denso). Son minutos de calendario, no de precio.
// Confundirlas cobraría o agendaría mal.
export const depilationPricingConfig = pgTable("depilation_pricing_config", {
  id: id(),
  singleton: boolean("singleton").notNull(),
  priceGrande: integer("price_grande").notNull(),
  priceMediana: integer("price_mediana").notNull(),
  priceChica: integer("price_chica").notNull(),
  pricingMinutesGrande: integer("pricing_minutes_grande").notNull(),
  pricingMinutesMediana: integer("pricing_minutes_mediana").notNull(),
  pricingMinutesChica: integer("pricing_minutes_chica").notNull(),
  tier1RatePerMinute: integer("tier1_rate_per_minute").notNull(),
  tier2RatePerMinute: integer("tier2_rate_per_minute").notNull(),
  slotMinutesFemaleGrande: integer("slot_minutes_female_grande").notNull(),
  slotMinutesFemaleMediana: integer("slot_minutes_female_mediana").notNull(),
  slotMinutesFemaleChica: integer("slot_minutes_female_chica").notNull(),
  slotMinutesMaleGrande: integer("slot_minutes_male_grande").notNull(),
  slotMinutesMaleMediana: integer("slot_minutes_male_mediana").notNull(),
  slotMinutesMaleChica: integer("slot_minutes_male_chica").notNull(),
  slotRoundingStep: integer("slot_rounding_step").notNull(),
  slotMinimumMinutes: integer("slot_minimum_minutes").notNull(),
  packSessions: integer("pack_sessions").notNull(),
  packDiscountPercentage: integer("pack_discount_percentage").notNull(),
  packRoundingBase: integer("pack_rounding_base").notNull(),
  updatedAt: updatedAt().notNull(),
});

// Un combo de depilación es un paquete de zonas, no de servicios (a
// diferencia de `combos`/`combo_service` en agenda.ts, que empaquetan
// sesiones de `service`). `kind` distingue dos formas de vender:
//   - 'pack_fijo': precio propio fijado a mano (`fixed_price` obligatorio),
//     ej. "Cuerpo Full" a $65.000 aunque la suma de sus zonas dé más.
//   - 'guardado': sin precio propio (`fixed_price` debe ser NULL); el precio
//     se calcula sumando el de cada zona elegida vía
//     `depilation_pricing_config`. Es "guardame esta selección de zonas",
//     no "cobrame este monto fijo".
// `choice_zone_count` es cuántas zonas de las incluidas son "a elección" del
// cliente (ver `depilation_combo_zone`) en vez de fijas en el pack.
//
// `name` es UNIQUE (`ux_depilation_combo_name`). Sin esto el `ON CONFLICT DO
// NOTHING` del seed no tiene índice contra qué chocar —el `id` siempre es un
// uuid nuevo— y re-pegar la migración duplicaría los 3 packs. No es teórico:
// ya pasó con la 1.34.0 en el SQL Editor de Supabase (cortó a mitad, la
// usuaria la corrió de nuevo).
export const depilationCombo = pgTable("depilation_combo", {
  id: id(),
  name: varchar("name", { length: 200 }).notNull().unique("ux_depilation_combo_name"),
  description: text("description"),
  kind: varchar("kind", { length: 20 }).notNull(), // pack_fijo | guardado
  fixedPrice: numeric("fixed_price", { precision: 10, scale: 2 }),
  fixedDurationMinutes: integer("fixed_duration_minutes"),
  choiceZoneCount: integer("choice_zone_count").notNull(),
  // Pack propio del combo (migración 1.36.0). Van de a tres: o las tres
  // cargadas, o las tres en NULL — lo garantiza `ck_dc_pack_completo`. NULL
  // significa "usá la política global de `depilation_pricing_config`", que es
  // también la que corre en toda cotización armada al vuelo, porque esa no
  // tiene combo del cual sacarla.
  packSessions: integer("pack_sessions"),
  packDiscountPercentage: integer("pack_discount_percentage"),
  packRoundingBase: integer("pack_rounding_base"),
  isPublishedWeb: boolean("is_published_web").notNull(),
  displayOrder: integer("display_order").notNull(),
  isActive: boolean("is_active").notNull(),
  createdAt: createdAt().notNull(),
  updatedAt: updatedAt().notNull(),
});

// Qué zonas trae cada combo. UNIQUE (combo_id, zone_id) en la migración
// evita que una misma zona quede cargada dos veces en el mismo combo.
export const depilationComboZone = pgTable("depilation_combo_zone", {
  id: id(),
  comboId: uuid("combo_id").notNull(),
  zoneId: uuid("zone_id").notNull(),
});
