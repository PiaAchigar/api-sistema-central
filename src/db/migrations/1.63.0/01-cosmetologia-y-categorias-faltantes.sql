-- ════════════════════════════════════════════════════════════════════════════
-- 1.63.0 / 01 — Cosmetología como categoría propia, y las que faltaban
-- ════════════════════════════════════════════════════════════════════════════
-- Pedido de Laura (2026-10-28, #32 de PENDIENTES.md), sobre su CATEGORIAS.md.
-- Decisión de Pia (2026-10-30): "Tratamientos Faciales" deja de existir. Todo
-- lo que tenía (servicios y subcategorías: Rejuvenecimiento, Manchas, Acné y
-- marcas de acné, Ojeras, Rosácea…) pasa a "Cosmetología Facial", que junto
-- con "Cosmetología Corporal" cuelga de la raíz nueva "Cosmetología".
--
-- Qué hace:
--   1. Crea "Cosmetología" (raíz) y "Cosmetología Corporal".
--   2. "Tratamientos Cosmetológicos" pasa a ser "Cosmetología Facial": cambia
--      de nombre y de padre, y se lleva sus hijas (Limpieza de cutis,
--      Dermaplaning, Peeling).
--   3. Las hijas y los servicios de "Tratamientos Faciales" pasan a
--      Cosmetología Facial, y "Tratamientos Faciales" se borra. También se
--      borran "Facial" y "Corporal" con lo que cuelga de ellas: estaban
--      DESACTIVADAS dentro de Tratamientos Cosmetológicos y sólo repetían
--      servicios que ya están en otras categorías.
--   4. Limpieza de espalda (y de glúteos) pasa de Estética Corporal a
--      Cosmetología Corporal: lo pidió Laura. Los objetivos de la cara
--      (Manchas, Acné y marcas de acné) se le sacan; el área Estética queda.
--   5. Crea las hojas que faltaban, cada una bajo el padre que indica Laura,
--      y engancha los tres servicios que ya existían con ese nombre. "Acné"
--      no se crea: ya está "Acné y marcas de acné", que llega desde
--      Tratamientos Faciales.
--   6. "Alisado de cejas" pasa a "Laminado y alisado de cejas".
--   7. "Dermatología" pasa a ser raíz y "Tratamientos Médicos" se borra: lo
--      que tenía además de Dermatología (Medicina Regenerativa, Terapéutica,
--      Cirugía Dermatológica) y sus servicios directos pasan a Dermatología.
--   8. "Depilación Definitiva" (con Crystal 3D Plus) y "Actividades" pasan a
--      tener también una categoría de verdad, no sólo el área. Se mudan ahí
--      las hijas que estaban colgadas del área (Depilación Facial/Corporal,
--      Pilates Reformer, Pilates Power 360, Thermobike). Comparten el nombre
--      con su área: el código distingue las áreas por `kind = 'area'`.
--   9. Las raíces quedan en el orden de CATEGORIAS.md.
--
-- La web esconde las categorías sin servicios: lo nuevo aparece en el menú
-- recién cuando Laura le asigna un servicio. Lo que sí cambia el menú ya es
-- Cosmetología (con todo lo de Tratamientos Faciales) y lo que sale de
-- Estética Corporal.
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
  v_tf           uuid;
  v_derm         uuid;
  v_tm           uuid;
  v_raiz         uuid;
  v_borrar       uuid[];
  v_hay_activa   boolean;
  v_orden        int;
  r              record;
BEGIN
  -- ── 1. Cosmetología (raíz), en el lugar de Tratamientos Faciales ─────────
  SELECT id INTO v_cosmetologia FROM categories WHERE name = 'Cosmetología';
  IF v_cosmetologia IS NULL THEN
    INSERT INTO categories (id, name, parent_category_id, kind, is_active, display_order)
    VALUES (gen_random_uuid(), 'Cosmetología', NULL, 'tecnica', true,
            COALESCE((SELECT display_order FROM categories WHERE name = 'Tratamientos Faciales'), 1))
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

  -- ── 3. Tratamientos Faciales se vacía en Cosmetología Facial y se borra ─
  SELECT id INTO v_tf FROM categories WHERE name = 'Tratamientos Faciales';
  IF v_tf IS NOT NULL THEN
    -- Las hijas, detrás de las que ya tiene Cosmetología Facial.
    SELECT COALESCE(max(display_order), 0) INTO v_orden
      FROM categories WHERE parent_category_id = v_facial;
    UPDATE categories SET parent_category_id = v_facial, display_order = display_order + v_orden
     WHERE parent_category_id = v_tf;

    INSERT INTO service_category (service_id, category_id)
    SELECT sc.service_id, v_facial FROM service_category sc
     WHERE sc.category_id = v_tf
       AND NOT EXISTS (SELECT 1 FROM service_category x
                        WHERE x.service_id = sc.service_id AND x.category_id = v_facial);
    DELETE FROM service_category WHERE category_id = v_tf;
    DELETE FROM categories WHERE id = v_tf;
  END IF;

  -- "Facial" y "Corporal" desactivadas, con todo lo que cuelga de ellas.
  -- Ordenadas de la hoja a la raíz: el FK al padre no es en cascada.
  WITH RECURSIVE sub AS (
    SELECT id, is_active, 0 AS nivel FROM categories
     WHERE parent_category_id = v_facial AND name IN ('Facial', 'Corporal') AND is_active = false
    UNION ALL
    SELECT c.id, c.is_active, sub.nivel + 1 FROM categories c JOIN sub ON c.parent_category_id = sub.id
  )
  SELECT array_agg(id ORDER BY nivel DESC), bool_or(is_active) INTO v_borrar, v_hay_activa FROM sub;
  IF v_hay_activa THEN
    RAISE EXCEPTION 'Debajo de las Facial/Corporal desactivadas hay una categoría activa: revisar antes de borrar';
  END IF;
  IF v_borrar IS NOT NULL THEN
    DELETE FROM service_category WHERE category_id = ANY (v_borrar);
    FOREACH v_padre IN ARRAY v_borrar LOOP
      DELETE FROM categories WHERE id = v_padre;
    END LOOP;
  END IF;

  -- ── 5. Las hojas que faltaban (antes que el 4: usa "Acné corporal") ─────
  FOR r IN
    SELECT * FROM (VALUES
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

  -- ── 7. Dermatología como raíz; Tratamientos Médicos se borra ────────────
  SELECT id INTO v_derm FROM categories WHERE name = 'Dermatología' AND kind <> 'area';
  SELECT id INTO v_tm FROM categories WHERE name = 'Tratamientos Médicos';
  IF v_derm IS NULL THEN
    RAISE EXCEPTION 'No está "Dermatología": ¿es el catálogo real?';
  END IF;
  UPDATE categories SET parent_category_id = NULL WHERE id = v_derm;
  IF v_tm IS NOT NULL THEN
    SELECT COALESCE(max(display_order), 0) INTO v_orden
      FROM categories WHERE parent_category_id = v_derm;
    UPDATE categories SET parent_category_id = v_derm, display_order = display_order + v_orden
     WHERE parent_category_id = v_tm;

    INSERT INTO service_category (service_id, category_id)
    SELECT sc.service_id, v_derm FROM service_category sc
     WHERE sc.category_id = v_tm
       AND NOT EXISTS (SELECT 1 FROM service_category x
                        WHERE x.service_id = sc.service_id AND x.category_id = v_derm);
    DELETE FROM service_category WHERE category_id = v_tm;
    DELETE FROM categories WHERE id = v_tm;
  END IF;

  -- ── 8. Depilación Definitiva y Actividades como categorías ──────────────
  FOR r IN SELECT * FROM (VALUES ('Depilación Definitiva'), ('Actividades')) AS t(nombre) LOOP
    SELECT id INTO v_raiz FROM categories WHERE name = r.nombre AND kind <> 'area';
    IF v_raiz IS NULL THEN
      INSERT INTO categories (id, name, parent_category_id, kind, is_active, display_order)
      VALUES (gen_random_uuid(), r.nombre, NULL, 'tecnica', true, 0)
      RETURNING id INTO v_raiz;
    END IF;
    -- Las hijas que estaban colgadas del área se mudan a la categoría.
    UPDATE categories SET parent_category_id = v_raiz
     WHERE parent_category_id IN (SELECT id FROM categories WHERE name = r.nombre AND kind = 'area');
    IF r.nombre = 'Depilación Definitiva'
       AND NOT EXISTS (SELECT 1 FROM categories WHERE name = 'Crystal 3D Plus') THEN
      INSERT INTO categories (id, name, parent_category_id, kind, is_active, display_order)
      VALUES (gen_random_uuid(), 'Crystal 3D Plus', v_raiz, 'maquina', true, 0);
    END IF;
  END LOOP;

  -- ── 9. Raíces en el orden de CATEGORIAS.md; las que no están, después ───
  FOR r IN SELECT * FROM (VALUES
      ('Actividades', 1), ('Estética Corporal', 2), ('Cosmetología', 3),
      ('Depilación Definitiva', 4), ('Belleza', 5), ('Masajes', 6),
      ('Manicuría y Pedicuría', 7), ('Dermatología', 8), ('Aparatología', 9)
    ) AS t(nombre, orden)
  LOOP
    UPDATE categories SET display_order = r.orden
     WHERE name = r.nombre AND kind <> 'area' AND parent_category_id IS NULL;
  END LOOP;

  RAISE NOTICE '1.63.0 aplicada: Cosmetología %, Facial %, Corporal %', v_cosmetologia, v_facial, v_corporal;
END $$;

-- Verificación (correr aparte):
-- SELECT c.name, p.name AS padre FROM categories c LEFT JOIN categories p ON p.id = c.parent_category_id
--  WHERE c.name LIKE 'Cosmetolog%' OR p.name LIKE 'Cosmetolog%' ORDER BY 2 NULLS FIRST, 1;
