-- 1.4.0 — Alinea la tabla TRAINING con producción y agrega campos web.
-- Idempotente: seguro de correr múltiples veces, en local Y en Supabase.

-- 1) Rename price -> list_price SOLO si todavía existe `price` y aún no existe `list_price`
--    (Supabase ya hizo este cambio el 2026-06-24; este bloque es no-op allí).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'training' AND column_name = 'price'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'training' AND column_name = 'list_price'
  ) THEN
    ALTER TABLE training RENAME COLUMN price TO list_price;
  END IF;
END $$;

-- 2) Asegurar columnas de precio / tax (no-op si ya existen)
ALTER TABLE training ADD COLUMN IF NOT EXISTS list_price   DECIMAL(10,2);
ALTER TABLE training ADD COLUMN IF NOT EXISTS cash_price   DECIMAL(10,2);
ALTER TABLE training ADD COLUMN IF NOT EXISTS tax_category VARCHAR(50);

-- 3) Campos web (espejo de la tabla service)
ALTER TABLE training ADD COLUMN IF NOT EXISTS is_featured       BOOLEAN DEFAULT false;
ALTER TABLE training ADD COLUMN IF NOT EXISTS is_visible        BOOLEAN DEFAULT true;
ALTER TABLE training ADD COLUMN IF NOT EXISTS web_sort_order    INTEGER;
ALTER TABLE training ADD COLUMN IF NOT EXISTS web_image_r2_path VARCHAR(500);
