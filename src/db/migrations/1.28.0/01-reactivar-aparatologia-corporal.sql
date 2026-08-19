-- ════════════════════════════════════════════════════════════════════════════
-- 1.28.0 — Reactivar la aparatología de Estética Corporal + crear "Combos"
-- ════════════════════════════════════════════════════════════════════════════
-- CONTEXTO: las 15 categorías de aparatología ya EXISTEN colgando de "Estética
-- Corporal" (0ff003a7-9909-4434-a15e-3069eeebff89), pero quedaron con
-- is_active = false cuando se aplicaron las migraciones 1.26.0/05 y /07.
--
-- Por eso esto es un UPDATE y no un INSERT: insertarlas habría creado 15
-- duplicadas, y los servicios ya asociados habrían seguido colgando de las
-- viejas (archivadas), o sea invisibles igual.
--
-- EFECTO MEDIDO contra producción el 2026-08-19, antes de aplicar:
--   - 15 categorías se reactivan
--   - 25 de los 35 servicios activos sin categoría activa vuelven a verse
--     en la web pública
--
-- Quedan 10 servicios invisibles después de esto. Todos cuelgan de cuatro
-- categorías archivadas de Dermatología que NO se tocan acá porque Laura pidió
-- resolverlas ella: "Ácido Hialurónico y Bioestimulantes", "Botox", "Dermapen"
-- y "Plasma Rico en Plaquetas (PRP)".
--
-- Idempotente: correrlo dos veces no cambia nada la segunda vez.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Reactivar las 15 de aparatología ──────────────────────────────────────
-- Las 13 del pedido original más "Mantas y Electrodos Térmicos" y "Mesoterapia
-- Corporal", agregadas después: ya colgaban de Estética Corporal, solo estaban
-- archivadas, y entre las dos tenían 4 servicios invisibles.
UPDATE categories
   SET is_active  = true,
       updated_at = now()
 WHERE parent_category_id = '0ff003a7-9909-4434-a15e-3069eeebff89'
   AND is_active IS DISTINCT FROM true
   AND name IN (
     'Alpha Synergy',
     'Crio-Radiofrecuencia',
     'Criolipólisis',
     'Electrodos / Ondas Rusas',
     'HIFU Corporal',
     'Lipoláser',
     'Mantas y Electrodos Térmicos',
     'Mesoterapia Corporal',
     'Mio Up',
     'Ondas de Choque (Hammer)',
     'Presoterapia',
     'Radiofrecuencia Corporal',
     'Ultracavitación',
     'Vela Slim',
     'Venus Legacy'
   );

-- ── 2. Crear "Combos" como categoría raíz (sin padre) ────────────────────────
-- `id` no tiene DEFAULT en esta tabla, así que hay que generarlo explícito.
INSERT INTO categories (id, parent_category_id, name, is_active, created_at, updated_at)
SELECT gen_random_uuid(), NULL, 'Combos', true, now(), now()
 WHERE NOT EXISTS (
   SELECT 1 FROM categories WHERE lower(trim(name)) = 'combos'
 );

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — correr después del COMMIT: 21 activas bajo Estética Corporal y 1 "Combos"
-- ════════════════════════════════════════════════════════════════════════════
SELECT name, is_active
  FROM categories
 WHERE parent_category_id = '0ff003a7-9909-4434-a15e-3069eeebff89'
 ORDER BY is_active DESC, name;

SELECT name, is_active, parent_category_id
  FROM categories
 WHERE lower(trim(name)) = 'combos';

-- Cuántos servicios activos siguen sin categoría activa (era 35 antes de esto,
-- tiene que quedar en 10):
SELECT count(*) AS servicios_invisibles_restantes
  FROM service s
 WHERE s.is_active
   AND NOT EXISTS (
     SELECT 1 FROM service_category sc
       JOIN categories c ON c.id = sc.category_id AND c.is_active
      WHERE sc.service_id = s.id
   );
