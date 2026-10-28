-- ════════════════════════════════════════════════════════════════════════════
-- 1.62.0 / 01 — Cosmetología como categoría propia, y las que faltaban
-- ════════════════════════════════════════════════════════════════════════════
-- Pedido de Laura (2026-10-28, #32 de PENDIENTES.md), sobre su CATEGORIAS.md.
-- Decisión de Pia: Cosmetología y Tratamientos Faciales son categorías
-- HERMANAS. Cosmetología = lo que hace la cosmetóloga (limpiezas, peelings,
-- dermaplaning, hidratación de labios), facial y corporal. Tratamientos
-- Faciales se queda con la aparatología facial (HIFU, IPL, radiofrecuencia)
-- y sus objetivos (rejuvenecimiento, manchas, ojeras, rosácea).
--
-- Qué hace:
--   1. Crea "Cosmetología" (raíz) y "Cosmetología Corporal".
--   2. "Tratamientos Cosmetológicos" pasa a ser "Cosmetología Facial": cambia
--      de nombre y de padre, y se lleva sus hijas (Limpieza de cutis,
--      Dermaplaning, Peeling). Se le suma "Hidratación de Labios".
--   3. HIFU e IPL salen de Cosmetología Facial. Siguen en Tratamientos
--      Faciales, en sus objetivos y en Aparatología Cosmetológica.
--   4. Limpieza de espalda (y de glúteos) pasa de Estética Corporal a
--      Cosmetología Corporal: lo pidió Laura. Los objetivos de la cara
--      (Manchas, Acné y marcas de acné) se le sacan; el área Estética queda.
--   5. Crea las hojas que faltaban, cada una bajo el padre que indica Laura,
--      y engancha los tres servicios que ya existían con ese nombre.
--   6. "Alisado de cejas" pasa a "Laminado y alisado de cejas".
--
-- La web esconde las categorías sin servicios: lo nuevo aparece en el menú
-- recién cuando Laura le asigna un servicio. Lo que sí cambia el menú ya es
-- Cosmetología (con lo que se mueve) y lo que sale de Estética Corporal.
--
-- Nombres únicos a propósito: las migraciones buscan categorías por nombre.
-- Donde el de Laura ya existía en otra rama, va con sufijo, igual que las de
-- Dermatología ("Celulitis (cosmetología)").
--
-- Un único bloque DO: el SQL Editor de Supabase hace autocommit por
-- sentencia, y así corre entera o no corre. Se puede volver a correr.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_cosmetologia uuid;
  v_facial       uuid;
  v_corporal     uuid;
  v_padre        uuid;
  v_hoja         uuid;
  v_orden        int;
  r              record;
BEGIN
  -- ── 1. Cosmetología (raíz), al lado de Tratamientos Faciales ─────────────
  SELECT id INTO v_cosmetologia FROM categories WHERE name = 'Cosmetología';
  IF v_cosmetologia IS NULL THEN
    INSERT INTO categories (id, name, parent_category_id, kind, is_active, display_order)
    VALUES (gen_random_uuid(), 'Cosmetología', NULL, 'tecnica', true,
            (SELECT display_order FROM categories WHERE name = 'Tratamientos Faciales'))
    RETURNING id INTO v_cosmetologia;
  END IF;

  -- ── 2. Tratamientos Cosmetológicos → Cosmetología Facial ────────────────
  SELECT id INTO v_facial FROM categories WHERE name = 'Cosmetología Facial';
  IF v_facial IS NULL THEN
    SELECT id INTO v_facial FROM categories WHERE name = 'Tratamientos Cosmetológicos';
    IF v_facial IS NULL THEN
      RAISE EXCEPTION 'No está "Tratamientos Cosmetológicos" ni "Cosmetología Facial": ¿es el catálogo real?';
    END IF;
    UPDATE categories
       SET name = 'Cosmetología Facial', parent_category_id = v_cosmetologia, display_order = 1
     WHERE id = v_facial;
  END IF;

  SELECT id INTO v_corporal FROM categories WHERE name = 'Cosmetología Corporal';
  IF v_corporal IS NULL THEN
    INSERT INTO categories (id, name, parent_category_id, kind, is_active, display_order)
    VALUES (gen_random_uuid(), 'Cosmetología Corporal', v_cosmetologia, 'tecnica', true, 2)
    RETURNING id INTO v_corporal;
  END IF;

  UPDATE categories SET parent_category_id = v_facial
   WHERE name = 'Hidratación de Labios' AND parent_category_id IS DISTINCT FROM v_facial;

  -- ── 3. HIFU e IPL no son cosmetología ───────────────────────────────────
  DELETE FROM service_category sc
   USING service s
   WHERE sc.service_id = s.id AND sc.category_id = v_facial
     AND (s.name ILIKE 'HIFU%' OR s.name ILIKE 'IPL%');

  -- ── 5. Las hojas que faltaban (antes que el 4: usa "Acné corporal") ─────
  FOR r IN
    SELECT * FROM (VALUES
      ('Cosmetología Facial',   'Acné',                               'objetivo'),
      ('Cosmetología Facial',   'Cicatrices',                         'objetivo'),
      ('Cosmetología Facial',   'Arrugas - Flaccidez',                'objetivo'),
      ('Cosmetología Facial',   'Piel seca',                          'objetivo'),
      ('Cosmetología Facial',   'Piel grasa',                         'objetivo'),
      ('Cosmetología Facial',   'Quistes de milium',                  'objetivo'),
      ('Cosmetología Corporal', 'Estrías (cosmetología)',             'objetivo'),
      ('Cosmetología Corporal', 'Acné corporal',                      'objetivo'),
      ('Cosmetología Corporal', 'Cicatrices de acné corporal',        'objetivo'),
      ('Cosmetología Corporal', 'Celulitis (cosmetología)',           'objetivo'),
      ('Masajes',               'Masajes Reductores',                 'tecnica'),
      ('Masajes',               'Drenaje Post Quirúrgico',            'tecnica'),
      ('Dermatología Clínica',  'Dermatoscopia',                      'tecnica'),
      ('Infecciones de la piel','Herpes',                             'objetivo'),
      ('Enfermedades inflamatorias y crónicas', 'Dermatosis',         'objetivo'),
      ('Bioestimuladores',      'Profhilo Structura',                 'tecnica'),
      ('Bioestimuladores',      'Harmonyca',                          'tecnica'),
      ('Arrugas y Flaccidez',   'Exosomas y factores de crecimiento', 'tecnica'),
      ('Contorno de ojos y párpados', 'Mesoterapia y peeling para ojeras', 'tecnica'),
      ('Contorno de ojos y párpados', 'Blefaroplastia no quirúrgica', 'tecnica'),
      ('Tratamiento Capilar',   'PRP capilar',                        'tecnica'),
      ('Tratamiento Capilar',   'Mesoterapia capilar',                'tecnica'),
      ('Tratamiento Capilar',   'Exosomas capilares',                 'tecnica'),
      ('Tratamiento Capilar',   'PDRN+',                              'tecnica'),
      ('Glúteos',               'Alidya',                             'tecnica')
    ) AS t(padre, nombre, kind)
  LOOP
    IF (SELECT count(*) FROM categories WHERE name = r.padre) <> 1 THEN
      RAISE EXCEPTION 'El padre "%" no existe o está repetido', r.padre;
    END IF;
    SELECT id INTO v_padre FROM categories WHERE name = r.padre;
    IF NOT EXISTS (SELECT 1 FROM categories WHERE name = r.nombre) THEN
      SELECT COALESCE(max(display_order), 0) + 1 INTO v_orden
        FROM categories WHERE parent_category_id = v_padre;
      INSERT INTO categories (id, name, parent_category_id, kind, is_active, display_order)
      VALUES (gen_random_uuid(), r.nombre, v_padre, r.kind, true, v_orden);
    END IF;
  END LOOP;

  -- ── 4. Limpieza de espalda y de glúteos → Cosmetología Corporal ─────────
  DELETE FROM service_category sc
   USING service s, categories c
   WHERE sc.service_id = s.id AND sc.category_id = c.id
     AND s.name IN ('Limpieza de Espalda', 'Limpieza de Espalda con Peeling', 'Limpieza de Glúteos con Peeling')
     AND c.name IN ('Estética Corporal', 'Cosmetología Facial', 'Manchas', 'Acné y marcas de acné');

  -- ── Servicios a sus categorías (nuevas o ya existentes) ─────────────────
  FOR r IN
    SELECT * FROM (VALUES
      ('Limpieza de Espalda',              'Acné corporal'),
      ('Limpieza de Espalda con Peeling',  'Acné corporal'),
      ('Limpieza de Glúteos con Peeling',  'Cosmetología Corporal'),
      ('DRENAJE LINFÁTICO POST QUIRÚRGICO CON ULTRASONIDO', 'Drenaje Post Quirúrgico'),
      ('Dermatoscopia - Control de Lunares', 'Dermatoscopia'),
      ('Alidya -  1 Zona',                 'Alidya')
    ) AS t(servicio, categoria)
  LOOP
    INSERT INTO service_category (service_id, category_id)
    SELECT s.id, c.id FROM service s, categories c
     WHERE s.name = r.servicio AND c.name = r.categoria
       AND NOT EXISTS (SELECT 1 FROM service_category x WHERE x.service_id = s.id AND x.category_id = c.id);
  END LOOP;

  -- ── 6. El nombre que usa Laura ──────────────────────────────────────────
  UPDATE categories SET name = 'Laminado y alisado de cejas'
   WHERE name = 'Alisado de cejas'
     AND NOT EXISTS (SELECT 1 FROM categories WHERE name = 'Laminado y alisado de cejas');

  RAISE NOTICE '1.62.0 aplicada: Cosmetología %, Facial %, Corporal %', v_cosmetologia, v_facial, v_corporal;
END $$;

-- Verificación (correr aparte):
-- SELECT c.name, p.name AS padre FROM categories c LEFT JOIN categories p ON p.id = c.parent_category_id
--  WHERE c.name LIKE 'Cosmetolog%' OR p.name LIKE 'Cosmetolog%' ORDER BY 2 NULLS FIRST, 1;
