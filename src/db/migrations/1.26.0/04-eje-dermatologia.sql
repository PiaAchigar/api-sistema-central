-- ════════════════════════════════════════════════════════════════════════════
-- 1.26.0 / 04 — Dermatología: clínica, estética por zona, y medicina terapéutica
-- ════════════════════════════════════════════════════════════════════════════
-- La base agrupaba por técnica (Botox, PRP, Dermapen); Laura la quiere por zona
-- o indicación. Además introdujo una rama que no estaba en su archivo original:
-- "Medicina Terapéutica", para lo que la dermatóloga aplica con fin terapéutico
-- y no estético (PRP corporales, mesoterapias).
--
-- Las categorías por técnica NO se archivan acá (eso es la Task 5b): si se
-- archivaran ahora, los ~50 servicios médicos que todavía no fueron reasignados
-- desaparecerían de la web.

-- ── Las tres ramas ──
INSERT INTO categories (id, parent_category_id, name, display_order, is_active, created_at, updated_at)
SELECT gen_random_uuid(), '5afba982-df5e-4fd4-b1ea-1dc498065c0d', v.name, v.ord, true, now(), now()
  FROM (VALUES
    ('Dermatología Clínica', 1), ('Dermatología Estética', 2), ('Medicina Terapéutica', 3)
  ) AS v(name, ord)
 WHERE NOT EXISTS (
   SELECT 1 FROM categories c
    WHERE c.name = v.name
      AND c.parent_category_id = '5afba982-df5e-4fd4-b1ea-1dc498065c0d');

-- ── Las zonas cuelgan de Dermatología Estética ──
INSERT INTO categories (id, parent_category_id, name, display_order, is_active, created_at, updated_at)
SELECT gen_random_uuid(), e.id, v.name, v.ord, true, now(), now()
  FROM (SELECT id FROM categories
         WHERE name = 'Dermatología Estética'
           AND parent_category_id = '5afba982-df5e-4fd4-b1ea-1dc498065c0d') e
  CROSS JOIN (VALUES
    ('Arrugas',1), ('Labios',2), ('Rinomodelación',3), ('Ojeras y Contorno de Ojos',4),
    ('Tratamiento Capilar',5), ('Rejuvenecimiento Íntimo',6), ('Manchas',7),
    ('Cicatrices',8), ('Estrías',9), ('Brazos',10), ('Abdomen',11), ('Glúteos',12)
  ) AS v(name, ord)
 WHERE NOT EXISTS (
   SELECT 1 FROM categories c WHERE c.name = v.name AND c.parent_category_id = e.id);

-- ════════════════════════════════════════════════════════════════════════════
-- Asociaciones service_category — SOLO las que Laura especificó textualmente.
-- `ON CONFLICT DO NOTHING` usa el UNIQUE de la Task 1, así que es re-corrible.
-- ════════════════════════════════════════════════════════════════════════════

-- Helper mental: `cat('Arrugas')` = la categoría Arrugas bajo Dermatología Estética.
-- Se resuelve con un subselect por nombre + padre porque los ids son nuevos.

-- ── ARRUGAS ──
-- Laura: "Agregar: Estética -> Arrugas -> Sonrisa Gingival, Botox para Bruxismo,
-- Botox para Hiperhidrosis". Más Profhilo, Exosomas y PDRN+ que nombró aparte.
INSERT INTO service_category (service_id, category_id, created_at)
SELECT s.id, c.id, now()
  FROM service s
  CROSS JOIN (SELECT c2.id FROM categories c2 JOIN categories p ON p.id=c2.parent_category_id
               WHERE c2.name='Arrugas' AND p.name='Dermatología Estética') c
 WHERE s.name IN (
   'Botox - Sonrisa Gingival', 'Botox para Bruxismo', 'Botox para Hiperhidrosis',
   'Profhilo - Sesión', 'Profhilo Structura - Sesión',
   'Exosomas y Factores de Crecimiento - Sesión', 'PDRN+ - Sesión por Zona',
   'Peeling Médico')
ON CONFLICT (service_id, category_id) DO NOTHING;

-- ── MANCHAS ──  Laura: "Peeling Médico → categoría de MANCHAS y ARRUGAS"
--                + Exosomas y PDRN+
INSERT INTO service_category (service_id, category_id, created_at)
SELECT s.id, c.id, now()
  FROM service s
  CROSS JOIN (SELECT c2.id FROM categories c2 JOIN categories p ON p.id=c2.parent_category_id
               WHERE c2.name='Manchas' AND p.name='Dermatología Estética') c
 WHERE s.name IN (
   'Peeling Médico',
   'Exosomas y Factores de Crecimiento - Sesión', 'PDRN+ - Sesión por Zona')
ON CONFLICT (service_id, category_id) DO NOTHING;

-- ── CICATRICES, TRATAMIENTO CAPILAR y ESTRÍAS ──
-- Laura: "Exosomas va en varias categorías: Cicatrices - Manchas - Arrugas -
-- Tratamiento Capilar - Estrias" e idem PDRN+.
INSERT INTO service_category (service_id, category_id, created_at)
SELECT s.id, c.id, now()
  FROM service s
  CROSS JOIN (SELECT c2.id FROM categories c2 JOIN categories p ON p.id=c2.parent_category_id
               WHERE c2.name IN ('Cicatrices','Tratamiento Capilar','Estrías')
                 AND p.name='Dermatología Estética') c
 WHERE s.name IN (
   'Exosomas y Factores de Crecimiento - Sesión', 'PDRN+ - Sesión por Zona')
ON CONFLICT (service_id, category_id) DO NOTHING;

-- El PRP capilar solo va en Tratamiento Capilar, no en las otras dos
INSERT INTO service_category (service_id, category_id, created_at)
SELECT s.id, c.id, now()
  FROM service s
  CROSS JOIN (SELECT c2.id FROM categories c2 JOIN categories p ON p.id=c2.parent_category_id
               WHERE c2.name='Tratamiento Capilar' AND p.name='Dermatología Estética') c
 WHERE s.name IN (
   'PRP - Facial y Capilar', 'PRP Facial o Capilar - Técnica Tradicional',
   'PRP Facial o Capilar con Dermapen')
ON CONFLICT (service_id, category_id) DO NOTHING;

-- ── LABIOS y RINOMODELACIÓN ──
INSERT INTO service_category (service_id, category_id, created_at)
SELECT s.id, c.id, now()
  FROM service s
  CROSS JOIN (SELECT c2.id FROM categories c2 JOIN categories p ON p.id=c2.parent_category_id
               WHERE c2.name='Labios' AND p.name='Dermatología Estética') c
 WHERE s.name IN ('Relleno de Labios con Ácido Hialurónico', 'Hialuronidasa')
ON CONFLICT (service_id, category_id) DO NOTHING;

INSERT INTO service_category (service_id, category_id, created_at)
SELECT s.id, c.id, now()
  FROM service s
  CROSS JOIN (SELECT c2.id FROM categories c2 JOIN categories p ON p.id=c2.parent_category_id
               WHERE c2.name='Rinomodelación' AND p.name='Dermatología Estética') c
 WHERE s.name = 'Rinomodelación con Ácido Hialurónico'
ON CONFLICT (service_id, category_id) DO NOTHING;

-- ── OJERAS Y CONTORNO DE OJOS ──
INSERT INTO service_category (service_id, category_id, created_at)
SELECT s.id, c.id, now()
  FROM service s
  CROSS JOIN (SELECT c2.id FROM categories c2 JOIN categories p ON p.id=c2.parent_category_id
               WHERE c2.name='Ojeras y Contorno de Ojos' AND p.name='Dermatología Estética') c
 WHERE s.name IN (
   'Sunekos - Tratamiento de Ojeras',
   'Blefaroplastia No Quirúrgica - Párpado Superior o Inferior',
   'Blefaroplastia No Quirúrgica - Párpado Superior y Inferior')
ON CONFLICT (service_id, category_id) DO NOTHING;

-- ── DERMATOLOGÍA CLÍNICA ──
INSERT INTO service_category (service_id, category_id, created_at)
SELECT s.id, c.id, now()
  FROM service s
  CROSS JOIN (SELECT id FROM categories
               WHERE name='Dermatología Clínica'
                 AND parent_category_id='5afba982-df5e-4fd4-b1ea-1dc498065c0d') c
 WHERE s.name IN (
   'Consulta Dermatológica', 'DERMATOLOGIA - Consulta',
   'PRIMERA VEZ - Consulta por Tratamiento', 'Dermatoscopia - Control de Lunares',
   'Electrocoagulación / Extracción de Verrugas',
   'Biopsia con Extracción y Estudio Patológico', 'Topicación')
ON CONFLICT (service_id, category_id) DO NOTHING;

-- ── MEDICINA TERAPÉUTICA ──
-- Lista textual de Laura. Incluye los 4 PRP corporales: "Los realiza la
-- Dermatóloga, así que parten de esa categoría".
-- OJO: "Mesoterapia Tenzora" NO existe en la base — Laura la da de alta aparte.
INSERT INTO service_category (service_id, category_id, created_at)
SELECT s.id, c.id, now()
  FROM service s
  CROSS JOIN (SELECT id FROM categories
               WHERE name='Medicina Terapéutica'
                 AND parent_category_id='5afba982-df5e-4fd4-b1ea-1dc498065c0d') c
 WHERE s.name IN (
   'PRP Corporal', 'PRP Corporal con Dermapen',
   'PRP - Promo 2 Zonas Corporales', 'PRP con Dermapen - Promo 2 Zonas Corporales',
   'Mesoterapia de Glúteos (Mesoestetic)',
   'Mesoterapia Lipolítica - Lipolytic (Mesoestetic)',
   'Mesoterapia Body Firming (Mesoestetic)',
   'Mesoterapia Anticelulítica - Cellullishock (Mesoestetic)',
   'Profhilo - Sesión')
ON CONFLICT (service_id, category_id) DO NOTHING;
