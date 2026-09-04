-- 1.37.0 / 01 — Ejes de clasificación del catálogo
--
-- `categories` venía siendo una bolsa plana de 73 filas donde convivían cuatro
-- preguntas distintas sobre un servicio. Esta columna las separa sin mover un
-- solo dato:
--
--   area      → "qué es": las pestañas de Administración (Estética, Medicina...)
--   tecnica   → "de qué tipo": agrupa DENTRO de una pestaña (Botox, Mesoterapia)
--   objetivo  → "para qué sirve": lo consume el buscador de la web
--   maquina   → "con qué": nombres de aparato. Duplican `service_machine`, que
--               quedó sin usar (3 filas contra 15 en `machines`). Se marcan para
--               poder encontrarlas; migrarlas es otra tarea.
--
-- El default es 'tecnica' porque es lo que más hay: marcar los otros tres ejes
-- es la excepción. Y porque así nada se rompe mientras la 02 no corra.
--
-- Una sola sentencia: el SQL Editor de Supabase hace autocommit por sentencia.
DO $$
BEGIN
  ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS kind varchar(12) NOT NULL DEFAULT 'tecnica';

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_categories_kind') THEN
    ALTER TABLE categories ADD CONSTRAINT ck_categories_kind
      CHECK (kind IN ('area', 'tecnica', 'objetivo', 'maquina'));
  END IF;

  RAISE NOTICE 'categories.kind listo — % categorías quedaron en tecnica por default',
    (SELECT count(*) FROM categories);
END $$;
