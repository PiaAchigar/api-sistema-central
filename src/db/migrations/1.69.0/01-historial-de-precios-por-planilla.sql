-- ════════════════════════════════════════════════════════════════════════════
-- 1.69.0 / 01 — Historial de precios por planilla (carga masiva de servicios)
-- ════════════════════════════════════════════════════════════════════════════
-- Cuando Laura sube una planilla .xlsx con cambios de precios, queda una fila en
-- `price_adjustments` con mode = 'planilla'. Esas filas no tienen dirección,
-- valor ni redondeo (no es un ajuste porcentual), así que esas tres columnas
-- pasan a admitir NULL. `category_id` guarda el id del área de la planilla.
-- De paso, `service.description` pasa a text si en esta base todavía es varchar
-- (en producción ya es text).
-- Un único bloque DO: corre entero o no corre. Idempotente.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tipo text;
BEGIN
  ALTER TABLE price_adjustments ALTER COLUMN direction DROP NOT NULL;
  ALTER TABLE price_adjustments ALTER COLUMN value DROP NOT NULL;
  ALTER TABLE price_adjustments ALTER COLUMN rounding DROP NOT NULL;
  RAISE NOTICE 'price_adjustments: direction, value y rounding admiten NULL';

  SELECT data_type INTO v_tipo
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'service' AND column_name = 'description';
  IF v_tipo IS NOT NULL AND v_tipo <> 'text' THEN
    ALTER TABLE service ALTER COLUMN description TYPE text;
    RAISE NOTICE 'service.description: % -> text', v_tipo;
  END IF;
END $$;

-- Verificación (correr aparte):
-- SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'price_adjustments' AND column_name IN ('direction','value','rounding');
-- SELECT data_type FROM information_schema.columns WHERE table_name = 'service' AND column_name = 'description';
