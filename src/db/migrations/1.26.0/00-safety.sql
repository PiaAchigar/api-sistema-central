-- ════════════════════════════════════════════════════════════════════════════
-- 1.26.0 / 00 — Red de seguridad antes de reestructurar categorías
-- ════════════════════════════════════════════════════════════════════════════
-- Copia de las 412 asociaciones servicio↔categoría tal como están hoy. Es la
-- única forma de volver atrás si un remapeo sale mal: `categories` conserva sus
-- ids en todo el plan, así que restaurar esta tabla restaura el mapeo exacto.
CREATE TABLE IF NOT EXISTS service_category_backup_1260 AS
  SELECT *, now() AS backed_up_at FROM service_category;

-- `service_category` no tenía PK ni UNIQUE: hoy se puede insertar dos veces la
-- misma dupla. Los remapeos de este plan insertan asociaciones nuevas, así que
-- sin esto un re-run duplicaría filas en silencio. Hoy hay 0 duplicados, así
-- que el constraint entra limpio.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_service_category') THEN
    ALTER TABLE service_category
      ADD CONSTRAINT uq_service_category UNIQUE (service_id, category_id);
  END IF;
END $$;
