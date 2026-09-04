-- 1.37.0 / 02 — Asignar su eje a cada categoría
--
-- La 01 dejó las 73 en 'tecnica' por default. Acá se marcan las excepciones.
-- Las listas salieron de leer las categorías reales de producción el
-- 2026-08-27; no son un supuesto.
--
-- Cuatro de las seis áreas YA EXISTEN como categorías (algunas archivadas y
-- vacías, de un intento anterior). Se reusan en vez de crear duplicados: si se
-- crearan de nuevo, quedarían dos "Estética" y el árbol de la web mostraría las
-- dos.
--
-- Una sola sentencia: el SQL Editor de Supabase hace autocommit por sentencia.
DO $$
DECLARE
  v_areas text[] := ARRAY[
    'Estética', 'Depilación Definitiva', 'Actividades', 'Capacitaciones'
  ];
  v_maquinas text[] := ARRAY[
    'Alpha Synergy', 'Crio-Radiofrecuencia', 'Criolipólisis', 'HIFU Corporal',
    'Mio Up', 'Vela Slim', 'Venus Legacy', 'Lipoláser', 'Presoterapia',
    'Ultracavitación', 'Ondas de Choque (Hammer)', 'Electrodos / Ondas Rusas',
    'Mantas y Electrodos Térmicos', 'Radiofrecuencia Corporal'
  ];
  v_objetivos text[] := ARRAY[
    'Arrugas', 'Manchas', 'Cicatrices', 'Estrías', 'Celulitis', 'Flaccidez',
    'Tonificar', 'Adiposidad Localizada', 'Reductor General', 'Drenaje Linfático',
    'Ojeras y Contorno de Ojos', 'Labios', 'Tratamiento Capilar',
    'Rejuvenecimiento Íntimo', 'Abdomen', 'Brazos', 'Glúteos', 'Corporal', 'Facial'
  ];
  v_faltan text[] := ARRAY['Medicina y Dermatología', 'Masajes y Bienestar'];
  v_n integer;
BEGIN
  UPDATE categories SET kind = 'area',     updated_at = now() WHERE name = ANY(v_areas);
  UPDATE categories SET kind = 'maquina',  updated_at = now() WHERE name = ANY(v_maquinas);
  UPDATE categories SET kind = 'objetivo', updated_at = now() WHERE name = ANY(v_objetivos);

  -- Las dos áreas que no existían todavía.
  INSERT INTO categories (id, name, kind, display_order, is_active, created_at, updated_at)
  SELECT gen_random_uuid(), n, 'area', 0, true, now(), now()
  FROM unnest(v_faltan) AS n
  WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.name = n);

  -- Una pestaña archivada no se puede mostrar. Cuatro de las seis venían
  -- archivadas del intento anterior (las '(Eje)' de la 1.26.0).
  UPDATE categories SET is_active = true, updated_at = now()
  WHERE kind = 'area' AND is_active IS DISTINCT FROM true;

  SELECT count(*) INTO v_n FROM categories WHERE kind = 'area';
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'Se esperaban 6 áreas y hay %. Revisar nombres antes de seguir.', v_n;
  END IF;

  RAISE NOTICE 'area=% tecnica=% objetivo=% maquina=%',
    v_n,
    (SELECT count(*) FROM categories WHERE kind = 'tecnica'),
    (SELECT count(*) FROM categories WHERE kind = 'objetivo'),
    (SELECT count(*) FROM categories WHERE kind = 'maquina');
END $$;
