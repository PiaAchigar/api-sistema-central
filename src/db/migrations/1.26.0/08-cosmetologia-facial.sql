-- ════════════════════════════════════════════════════════════════════════════
-- 1.26.0 / 08 — Cosmetología se parte en Facial y Corporal
-- ════════════════════════════════════════════════════════════════════════════
-- Respuesta de Laura (2026-08-15) a la pregunta que había quedado abierta:
-- "¿Facial/Corporal reemplaza a las 5 subcategorías actuales, o esas 5 se meten
-- adentro de Facial?" → **Esas 5 se meten adentro de Facial.**
--
-- O sea que NO se archiva nada acá: las 5 subcategorías siguen vivas con todos
-- sus servicios, solo que ahora cuelgan un nivel más abajo. Ningún servicio
-- cambia de categoría, así que ninguno puede desaparecer de la web.
--
-- `Corporal` se crea vacía a propósito: en el archivo de Laura tiene Estrías,
-- Acné Corporal, Cicatrices de Acné y Celulitis, pero esos servicios todavía no
-- existen o están en otra rama. La web oculta sola las categorías sin servicios,
-- así que una categoría vacía no molesta hasta que ella la llene.
--
-- Idempotente: se puede correr más de una vez.

-- ── Facial y Corporal, hijas de Cosmetología ──
INSERT INTO categories (id, parent_category_id, name, display_order, is_active, created_at, updated_at)
SELECT gen_random_uuid(), 'be4a2d02-85fb-4d47-aae3-5d26090edbdd', v.name, v.ord, true, now(), now()
  FROM (VALUES ('Facial', 1), ('Corporal', 2)) AS v(name, ord)
 WHERE NOT EXISTS (
   SELECT 1 FROM categories c
    WHERE c.name = v.name
      AND c.parent_category_id = 'be4a2d02-85fb-4d47-aae3-5d26090edbdd');

-- ── Las 5 subcategorías existentes pasan a colgar de Facial ──
-- Se listan por id y no por nombre porque "Limpieza de Cutis y Cosmetología"
-- contiene la palabra Cosmetología y un match por nombre sería frágil.
UPDATE categories
   SET parent_category_id = (SELECT id FROM categories
                              WHERE name = 'Facial'
                                AND parent_category_id = 'be4a2d02-85fb-4d47-aae3-5d26090edbdd'),
       updated_at = now()
 WHERE id IN ('cb78e23e-c20e-45da-bc3e-46cec03b0b8e',   -- Limpieza de Cutis y Cosmetología (7)
              'e0ae98de-e9d3-4666-b274-f788fce1e5ca',   -- Peeling y Dermaplaning (2)
              '64900969-7ea4-4482-95a6-f6de65b2343e',   -- Aparatología Facial (14)
              '98f5a195-70e6-400b-9519-b73e4bd33ac4',   -- Hidratación de Labios (2)
              'fa78e259-3002-454f-b916-8b7688c568ad');  -- Tratamientos Faciales por Sesiones (2)
