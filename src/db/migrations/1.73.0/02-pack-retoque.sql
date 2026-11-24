-- 1.73.0/02 — "La última sesión es retoque" en los packs de catálogo (#36).
--
-- Botox, ácido hialurónico, etc.: la última sesión del pack es un retoque y NO se
-- cobra (el pack cuesta N-1 sesiones, y después va el descuento del pack).
-- Sólo un pack (kind = 'pack') puede llevarla en true.
--
-- ORDEN DE DEPLOY: ANTES de deployar la API (el Worker nuevo lee la columna).
--
-- Una sola sentencia (DO), idempotente.
DO $$
BEGIN
  ALTER TABLE combos
    ADD COLUMN IF NOT EXISTS last_session_is_touchup boolean NOT NULL DEFAULT false;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_combos_touchup_solo_pack') THEN
    ALTER TABLE combos
      ADD CONSTRAINT ck_combos_touchup_solo_pack
      CHECK (last_session_is_touchup = false OR kind = 'pack');
  END IF;

  RAISE NOTICE '1.73.0/02: combos.last_session_is_touchup lista';
END $$;

-- Verificación (correr aparte):
-- SELECT column_name, column_default FROM information_schema.columns
--  WHERE table_name = 'combos' AND column_name = 'last_session_is_touchup';
