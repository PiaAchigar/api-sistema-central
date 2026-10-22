-- ════════════════════════════════════════════════════════════════════════════
-- 1.61.0 / 01 — Días entre sesiones (planificador de la compra)
-- ════════════════════════════════════════════════════════════════════════════
-- Cada cuántos días se sugiere agendar la siguiente sesión de una compra de
-- varias sesiones. NULL = "no cargado": el planificador usa 30 por defecto.
--
--   · combos.session_interval_days            (combos y packs)
--   · promotions.session_interval_days        (promos tipo paquete)
--   · depilation_combo.session_interval_days  (packs de depilación)
--   · depilation_pricing_config.session_interval_days
--       el valor general de Depilación → Packs, para un pack que no tiene el suyo.
--
-- Orden de búsqueda: el del combo/pack/promo → (depilación) el de la config →
-- 30. Positivo siempre: 0 o negativo no tienen sentido (CHECK).
--
-- Cada ADD COLUMN es una sentencia que anda sola en el SQL Editor de Supabase
-- (autocommit por sentencia, IF NOT EXISTS). Los CHECK van juntos en un único
-- bloque DO, con guarda de existencia, para poder volver a correr la migración.
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE combos ADD COLUMN IF NOT EXISTS session_interval_days integer;
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS session_interval_days integer;
ALTER TABLE depilation_combo ADD COLUMN IF NOT EXISTS session_interval_days integer;
ALTER TABLE depilation_pricing_config ADD COLUMN IF NOT EXISTS session_interval_days integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_combos_session_interval_days') THEN
    ALTER TABLE combos ADD CONSTRAINT ck_combos_session_interval_days
      CHECK (session_interval_days IS NULL OR session_interval_days > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_promotions_session_interval_days') THEN
    ALTER TABLE promotions ADD CONSTRAINT ck_promotions_session_interval_days
      CHECK (session_interval_days IS NULL OR session_interval_days > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_dc_session_interval_days') THEN
    ALTER TABLE depilation_combo ADD CONSTRAINT ck_dc_session_interval_days
      CHECK (session_interval_days IS NULL OR session_interval_days > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_dpc_session_interval_days') THEN
    ALTER TABLE depilation_pricing_config ADD CONSTRAINT ck_dpc_session_interval_days
      CHECK (session_interval_days IS NULL OR session_interval_days > 0);
  END IF;
END $$;

-- Verificación (correr aparte):
--   SELECT table_name, is_nullable FROM information_schema.columns
--    WHERE column_name = 'session_interval_days' ORDER BY 1;
