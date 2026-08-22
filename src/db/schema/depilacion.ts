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
  name: varchar("name", { length: 100 }),
  category: varchar("category", { length: 10 }), // grande | mediana | chica
  displayOrder: integer("display_order"),
  isActive: boolean("is_active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Pares de zonas que no tiene sentido vender juntas porque una incluye a la
// otra (ej: Pierna entera excluye Media pierna). La migración carga las dos
// direcciones del par, así que alcanza con filtrar por `zone_id` en
// cualquiera de los dos sentidos sin tener que armar el OR a mano.
export const zoneExclusion = pgTable("zone_exclusion", {
  id: id(),
  zoneId: uuid("zone_id"),
  excludesZoneId: uuid("excludes_zone_id"),
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
  singleton: boolean("singleton"),
  priceGrande: integer("price_grande"),
  priceMediana: integer("price_mediana"),
  priceChica: integer("price_chica"),
  pricingMinutesGrande: integer("pricing_minutes_grande"),
  pricingMinutesMediana: integer("pricing_minutes_mediana"),
  pricingMinutesChica: integer("pricing_minutes_chica"),
  tier1RatePerMinute: integer("tier1_rate_per_minute"),
  tier2RatePerMinute: integer("tier2_rate_per_minute"),
  slotMinutesFemaleGrande: integer("slot_minutes_female_grande"),
  slotMinutesFemaleMediana: integer("slot_minutes_female_mediana"),
  slotMinutesFemaleChica: integer("slot_minutes_female_chica"),
  slotMinutesMaleGrande: integer("slot_minutes_male_grande"),
  slotMinutesMaleMediana: integer("slot_minutes_male_mediana"),
  slotMinutesMaleChica: integer("slot_minutes_male_chica"),
  slotRoundingStep: integer("slot_rounding_step"),
  slotMinimumMinutes: integer("slot_minimum_minutes"),
  packSessions: integer("pack_sessions"),
  packDiscountPercentage: integer("pack_discount_percentage"),
  packRoundingBase: integer("pack_rounding_base"),
  updatedAt: updatedAt(),
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
export const depilationCombo = pgTable("depilation_combo", {
  id: id(),
  name: varchar("name", { length: 200 }),
  description: text("description"),
  kind: varchar("kind", { length: 20 }), // pack_fijo | guardado
  fixedPrice: numeric("fixed_price", { precision: 10, scale: 2 }),
  fixedDurationMinutes: integer("fixed_duration_minutes"),
  choiceZoneCount: integer("choice_zone_count"),
  isPublishedWeb: boolean("is_published_web"),
  displayOrder: integer("display_order"),
  isActive: boolean("is_active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Qué zonas trae cada combo. UNIQUE (combo_id, zone_id) en la migración
// evita que una misma zona quede cargada dos veces en el mismo combo.
export const depilationComboZone = pgTable("depilation_combo_zone", {
  id: id(),
  comboId: uuid("combo_id"),
  zoneId: uuid("zone_id"),
});
