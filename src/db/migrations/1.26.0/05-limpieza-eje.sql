-- ════════════════════════════════════════════════════════════════════════════
-- 1.26.0 / 05 — Archivar los buckets (Eje) y dejar 0 servicios sin categoría
-- ════════════════════════════════════════════════════════════════════════════
-- Los (Eje) eran buckets operativos planos que la web ya ocultaba filtrando por
-- el "Eje" del nombre. Con el árbol nuevo no cumplen ninguna función: sus 147
-- servicios están todos, además, en una categoría real.
--
-- Se ARCHIVAN, no se borran (regla 1.3), y sus asociaciones se conservan: si
-- alguna vez hay que reactivarlos, vuelven con sus servicios intactos.
--
-- ⚠️ Sutileza que se descubrió armando este plan y que NO estaba reflejada en
-- el chequeo 'servicios activos sin categoría' original: un `(Eje)` está
-- `is_active = true` en la base — la web lo esconde filtrando el nombre, no el
-- flag. Eso significa que, ANTES de esta migración, un servicio que cuelga
-- SOLO de un `(Eje)` cuenta como "categorizado" para cualquier chequeo que
-- solo mire `is_active`, aunque sea invisible en pantalla. El chequeo correcto
-- siempre fue el que además exige `c.is_active` (ver Step 3 abajo) — pero antes
-- de archivar los Eje, ese filtro no bastaba por sí solo para detectar el caso
-- "solo cuelga de un Eje", porque el Eje también pasaba `c.is_active`. Recién
-- después de este UPDATE, `c.is_active` excluye a los Eje y el chequeo queda
-- correcto sin trampa. Por eso el Step 1 (re-verificación manual) es
-- imprescindible antes de correr esto: es la única red de seguridad mientras
-- los Eje siguen activos.

UPDATE categories
   SET is_active = false,
       description = COALESCE(description || ' | ', '') ||
                     'Archivada en 1.26.0: bucket operativo sin uso tras la reestructura.'
 WHERE name LIKE '%Eje%';

-- `Cavado Completo` es el único servicio activo sin ninguna categoría. Es una
-- depilación, va con las corporales.
INSERT INTO service_category (service_id, category_id, created_at)
SELECT 'ef6a4ccc-f784-4b7d-a3a2-d9f9471b1e89', c.id, now()
  FROM categories c
 WHERE c.name = 'Depilación Definitiva Corporal'
ON CONFLICT (service_id, category_id) DO NOTHING;
