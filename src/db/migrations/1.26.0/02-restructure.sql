-- ════════════════════════════════════════════════════════════════════════════
-- 1.26.0 / 02 — El árbol pasa a la estructura de nueva_estructura_categorias.md
-- ════════════════════════════════════════════════════════════════════════════
-- Solo renombra y recuelga categorías EXISTENTES: los `id` no cambian, así que
-- las 391 filas de service_category siguen válidas y ningún servicio se toca.
--
-- "Estética" y "General" eran envoltorios artificiales que Laura no tiene en su
-- estructura: sus hijas pasan a ser raíces y los envoltorios se archivan.
--
-- NO se tocan: Estética(Eje), General(Eje) (buckets internos que la web filtra
-- por el "Eje" en el nombre — renombrarlas las haría aparecer en la web con 147
-- servicios sueltos) ni Promos del Mes.

-- ── Las hijas de Estética pasan a raíz, con el nombre que usa Laura ──
UPDATE categories SET parent_category_id = NULL, name = 'Estética Corporal', display_order = 2
 WHERE id = '0ff003a7-9909-4434-a15e-3069eeebff89';

UPDATE categories SET parent_category_id = NULL, name = 'Dermatología', display_order = 8
 WHERE id = '5afba982-df5e-4fd4-b1ea-1dc498065c0d';

UPDATE categories SET parent_category_id = NULL, name = 'Cosmetología', display_order = 3
 WHERE name = 'Tratamientos Faciales'
   AND parent_category_id = '6d1a1009-16bd-4c9f-b0b3-f740a03e7997';

UPDATE categories SET parent_category_id = NULL, name = 'Belleza', display_order = 5
 WHERE name = 'Belleza (Cejas y Pestañas)';

UPDATE categories SET parent_category_id = NULL, name = 'Manicuría', display_order = 7
 WHERE name = 'Manicuría y Pedicuría';

-- ── Las hijas de General pasan a raíz ──
UPDATE categories SET parent_category_id = NULL, name = 'Masajes', display_order = 6
 WHERE name = 'Masajes' AND parent_category_id = 'b329d20f-305f-4994-8a5c-fcf3f2d92f5d';

UPDATE categories SET parent_category_id = NULL, display_order = 9
 WHERE id = '167b3816-6823-4176-b98f-5c02dd9262ce';   -- Capacitaciones

-- ── "Pilates" (bajo General) se convierte en la raíz "Actividades" ──
-- Se reusa esa categoría en vez de crear una nueva porque ya tiene colgadas a
-- Pilates Reformer y Pilates Power 360.
UPDATE categories SET parent_category_id = NULL, name = 'Actividades', display_order = 1
 WHERE id = 'c5f0c82d-7cb2-45ad-b4d4-593f4827a5f0';

-- Thermobike deja de colgar de General y pasa a ser hija de Actividades
UPDATE categories SET parent_category_id = 'c5f0c82d-7cb2-45ad-b4d4-593f4827a5f0', display_order = 3
 WHERE id = '8ab6b67f-f92a-4b3c-8505-d66c630fda71';

-- ── Depilación se renombra como la nombra Laura ──
UPDATE categories SET name = 'Depilación Definitiva', display_order = 4
 WHERE id = '7985e9c1-15ed-4846-b97d-63984a178e5e';

-- ── Los envoltorios quedan archivados, no borrados (regla 1.3) ──
UPDATE categories
   SET is_active = false,
       description = COALESCE(description || ' | ', '') ||
                     'Archivada en 1.26.0: envoltorio artificial, sus hijas pasaron a raíz.'
 WHERE id IN ('6d1a1009-16bd-4c9f-b0b3-f740a03e7997',   -- Estética
              'b329d20f-305f-4994-8a5c-fcf3f2d92f5d');  -- General
