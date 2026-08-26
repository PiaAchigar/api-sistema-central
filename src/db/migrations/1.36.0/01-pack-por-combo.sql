-- ════════════════════════════════════════════════════════════════════════════
-- 1.36.0 / 01 — Pack de sesiones por combo de depilación
-- ════════════════════════════════════════════════════════════════════════════
-- UNA SOLA SENTENCIA, por lo mismo de siempre: el SQL Editor de Supabase hace
-- autocommit por sentencia, así que una migración de varias puede quedar a
-- medio aplicar si una falla. Ver la nota en 1.35.0/01.
--
-- Qué cambia:
--   `depilation_combo` gana tres columnas para que cada combo pueda definir su
--   propio pack: cuántas sesiones trae, qué descuento lleva y a qué múltiplo
--   se redondea. Laura vende algunos combos en 3 sesiones y otros en 5, con
--   distintos descuentos, y eso no entra en `depilation_pricing_config`, que
--   es de una sola fila (CHECK + UNIQUE sobre `singleton`).
--
-- Las tres son NULLABLES y arrancan en NULL a propósito:
--   NULL = este combo usa la política global de la pantalla Precios.
--   Cargadas = este combo usa las suyas.
-- Así ningún combo ya cargado cambia de precio el día que se aplica esto, y
-- las cotizaciones armadas al vuelo —que no tienen combo— siguen usando la
-- global como siempre.
--
-- `ck_dc_pack_completo` exige que estén LAS TRES o NINGUNA. Media política no
-- existe: si alguien cargara "5 sesiones" sin descuento, habría que inventar
-- de dónde sale ese descuento, y ahí es donde nacen los precios que después
-- nadie sabe explicar.
--
-- Idempotente: `ADD COLUMN IF NOT EXISTS` y las constraints se agregan solo si
-- no están. Correrla dos veces contra la misma base no rompe nada — cosa que
-- ya pasó de verdad con la 1.34.0 en el editor de Supabase.

DO $$
BEGIN
  ALTER TABLE depilation_combo
    ADD COLUMN IF NOT EXISTS pack_sessions            integer,
    ADD COLUMN IF NOT EXISTS pack_discount_percentage integer,
    ADD COLUMN IF NOT EXISTS pack_rounding_base       integer;

  -- Rangos de cada perilla. Se validan solo cuando la columna tiene valor:
  -- NULL siempre pasa, que es lo que hace posible "usar la global".
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_dc_pack_sesiones') THEN
    ALTER TABLE depilation_combo ADD CONSTRAINT ck_dc_pack_sesiones
      CHECK (pack_sessions IS NULL OR pack_sessions > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_dc_pack_descuento') THEN
    ALTER TABLE depilation_combo ADD CONSTRAINT ck_dc_pack_descuento
      CHECK (pack_discount_percentage IS NULL
             OR (pack_discount_percentage >= 0 AND pack_discount_percentage <= 100));
  END IF;

  -- > 0 y no >= 0: el redondeo es un divisor (`round(bruto / redondeo)`), así
  -- que un 0 acá no sería "sin redondeo", sería una división por cero.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_dc_pack_redondeo') THEN
    ALTER TABLE depilation_combo ADD CONSTRAINT ck_dc_pack_redondeo
      CHECK (pack_rounding_base IS NULL OR pack_rounding_base > 0);
  END IF;

  -- Las tres o ninguna.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_dc_pack_completo') THEN
    ALTER TABLE depilation_combo ADD CONSTRAINT ck_dc_pack_completo
      CHECK (
        (pack_sessions IS NULL AND pack_discount_percentage IS NULL AND pack_rounding_base IS NULL)
        OR
        (pack_sessions IS NOT NULL AND pack_discount_percentage IS NOT NULL AND pack_rounding_base IS NOT NULL)
      );
  END IF;

  RAISE NOTICE 'Migración 1.36.0 aplicada.';
END $$;

-- Verificación (correr aparte, NO es parte de la migración):
-- SELECT count(*) FROM depilation_combo WHERE pack_sessions IS NOT NULL;   -- 0 recién aplicada
-- SELECT conname FROM pg_constraint WHERE conrelid = 'depilation_combo'::regclass
--   AND conname LIKE 'ck_dc_pack%';                                        -- 4 filas
