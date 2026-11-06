-- 1.67.0 — Vender zonas de depilación sueltas desde el CRM.
--
-- Una venta de zonas sueltas no tiene un pack del catálogo, pero la agenda, la
-- ficha y el consumo cuelgan de `depilation_combo`. En vez de duplicar ese
-- circuito, la venta se apoya en un combo `a_medida`: una fila oculta (no sale
-- en el dashboard, ni en la venta, ni en la web) con las zonas elegidas. Las
-- mismas zonas reusan la misma fila.
--
-- Una sola sentencia, para que corra entera en el SQL Editor de Supabase.
-- Se puede volver a correr sin problema.
ALTER TABLE depilation_combo
  DROP CONSTRAINT IF EXISTS ck_dc_kind,
  ADD CONSTRAINT ck_dc_kind CHECK (kind IN ('pack_fijo', 'guardado', 'a_medida'));

-- Verificación (correr aparte):
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_dc_kind';
