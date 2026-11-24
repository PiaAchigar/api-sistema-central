-- 1.73.0/01 — Borra `validity_months` de `combos` y `depilation_combo` (#46).
--
-- Desde la 1.66.0 la vigencia es SÓLO `validity_weeks`; los meses quedaron
-- sin uso. Ya no los lee ni los escribe ningún código.
--
-- ORDEN DE DEPLOY: esta migración va DESPUÉS de deployar la API y la web sin la
-- columna. Si corre antes, el Worker viejo hace SELECT/INSERT de una columna
-- que ya no existe.
--
-- Una sola sentencia (DO) para que ande en el SQL Editor de Supabase, que hace
-- autocommit por sentencia. Idempotente: si la columna ya no está, no hace nada.
-- Guarda: si queda un combo con meses y SIN semanas, la vigencia se perdería al
-- borrar; se aborta con EXCEPTION y no se borra nada.
DO $$
DECLARE
  n_combos int := 0;
  n_dep    int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'combos'
                AND column_name = 'validity_months') THEN
    EXECUTE 'SELECT count(*) FROM combos WHERE validity_months IS NOT NULL AND validity_weeks IS NULL'
       INTO n_combos;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'depilation_combo'
                AND column_name = 'validity_months') THEN
    EXECUTE 'SELECT count(*) FROM depilation_combo WHERE validity_months IS NOT NULL AND validity_weeks IS NULL'
       INTO n_dep;
  END IF;

  IF n_combos > 0 OR n_dep > 0 THEN
    RAISE EXCEPTION '1.73.0/01: hay % combos y % packs de depilación con validity_months y sin validity_weeks: se perdería la vigencia. No se borró nada.',
      n_combos, n_dep;
  END IF;

  -- El CHECK de una sola columna (ck_combos_validity_months, etc.) se va con ella.
  ALTER TABLE combos           DROP COLUMN IF EXISTS validity_months;
  ALTER TABLE depilation_combo DROP COLUMN IF EXISTS validity_months;

  RAISE NOTICE '1.73.0/01: validity_months borrada de combos y depilation_combo';
END $$;

-- Verificación (correr aparte):
-- SELECT table_name FROM information_schema.columns WHERE column_name = 'validity_months';  -- 0 filas
