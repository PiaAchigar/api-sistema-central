-- ════════════════════════════════════════════════════════════════════════════
-- 1.26.0 / 03 — Estética Corporal pasa a agruparse por INDICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- La base agrupaba por aparatología (Criolipólisis, Vela Slim…); Laura la quiere
-- por indicación (Celulitis, Flaccidez…). No es un renombre: una aparatología
-- sirve para varias indicaciones y por eso los servicios se repiten entre ellas.
-- `service_category` es N:M, así que eso es exactamente lo que modela.
--
-- Las categorías se crean VACÍAS a propósito: qué aparato trata qué indicación
-- es criterio clínico de Laura, y lo carga ella desde el dashboard.
--
-- Las aparatologías NO se archivan acá (eso es la Task 5b, después de que Laura
-- termine): si se archivaran ahora, sus 33 servicios quedarían sin categoría
-- activa y desaparecerían de la web hasta que ella termine de reasignar.

INSERT INTO categories (id, parent_category_id, name, display_order, is_active, created_at, updated_at)
SELECT gen_random_uuid(), '0ff003a7-9909-4434-a15e-3069eeebff89', v.name, v.ord, true, now(), now()
  FROM (VALUES
    ('Celulitis', 1), ('Flaccidez', 2), ('Reductor General', 3),
    ('Adiposidad Localizada', 4), ('Tonificar', 5), ('Drenaje Linfático', 6)
  ) AS v(name, ord)
 WHERE NOT EXISTS (
   SELECT 1 FROM categories c
    WHERE c.name = v.name
      AND c.parent_category_id = '0ff003a7-9909-4434-a15e-3069eeebff89');
