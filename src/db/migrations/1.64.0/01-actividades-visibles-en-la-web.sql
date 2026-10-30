-- ════════════════════════════════════════════════════════════════════════════
-- 1.64.0 / 01 — Check "Publicar en la web" para las actividades (#43)
-- ════════════════════════════════════════════════════════════════════════════
-- Pedido de Pia (2026-10-30). Las capacitaciones (`training.is_visible`), los
-- packs (`depilation_combo.is_published_web`) y los combos
-- (`combos.is_visible_web`) ya tienen su check; las actividades no: la web
-- mostraba toda actividad activa, y la única forma de sacar una era
-- archivarla, con lo que tampoco se podía agendar.
--
-- Default `true`: las 13 que hoy se ven en la web se siguen viendo. Laura
-- destilda las que no quiere publicar desde Sitio Web → Visibles en la web.
--
-- Una sola sentencia, idempotente.
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE activities ADD COLUMN IF NOT EXISTS is_visible_web boolean NOT NULL DEFAULT true;

-- Verificación (correr aparte):
-- SELECT name, is_active, is_visible_web FROM activities ORDER BY name;
