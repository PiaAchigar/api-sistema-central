-- ════════════════════════════════════════════════════════════════════════════
-- 1.19.0 — Campos de tratamientos en servicios para búsqueda semántica
-- ════════════════════════════════════════════════════════════════════════════
-- Agregar campos necesarios para el buscador de tratamientos:
--   · benefits: beneficios del servicio (ej: "Rápido, indoloro")
--   · contraindications: contraindicaciones (ej: "Embarazo, fotosenibilidad")
--   · special_attention_notes: notas especiales (ej: "No exponerse al sol 48hs")
--   · unit_price_list: precio de lista (lista de precios public)

ALTER TABLE service
  ADD COLUMN IF NOT EXISTS benefits TEXT,
  ADD COLUMN IF NOT EXISTS contraindications TEXT,
  ADD COLUMN IF NOT EXISTS special_attention_notes TEXT,
  ADD COLUMN IF NOT EXISTS unit_price_list DECIMAL(10, 2);

-- Backfill: si no hay unit_price_list, copiar de unit_price
UPDATE service
  SET unit_price_list = unit_price
  WHERE unit_price_list IS NULL
    AND unit_price IS NOT NULL;
