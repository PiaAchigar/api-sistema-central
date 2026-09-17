-- 1.54.0 — Borrar 4 clasificaciones muertas (+ 1 subcategoría)
--
-- El rediseño de la página de Servicios muestra las "clasificaciones" (las
-- categorías sin padre que NO son áreas) en el menú lateral. Hoy son 12 y
-- cuatro no deberían mostrarse nunca:
--
--   Estética(Eje), General(Eje)  — restos de una importación vieja, vacías.
--   General                      — vacía salvo una subcategoría "Nutrición"
--                                  que también está vacía y desactivada.
--   Combos                       — vacía. Además el rediseño agrega un botón
--                                  "Combos" al menú: tener encima una
--                                  clasificación con el mismo nombre que no
--                                  lleva a lo mismo es una trampa.
--
-- NO se toca "Promos del Mes": sus 14 servicios están desactivados pero
-- siguen colgando de ella, y borrarla es una decisión aparte.
--
-- Un solo bloque DO: el SQL Editor de Supabase hace autocommit por sentencia,
-- así que las guardas y los borrados tienen que viajar juntos o no viajar.
DO $$
DECLARE
  v_ids   uuid[];
  v_n     int;
  v_sobra text;
BEGIN
  -- Las 4 raíces por nombre Y por no tener padre: hay categorías con estos
  -- nombres más abajo en el árbol que no son las que queremos borrar.
  SELECT array_agg(id) INTO v_ids
  FROM categories
  WHERE parent_category_id IS NULL
    AND name IN ('Estética(Eje)', 'General', 'General(Eje)', 'Combos');

  IF v_ids IS NULL OR array_length(v_ids, 1) <> 4 THEN
    RAISE EXCEPTION 'Esperaba 4 clasificaciones a borrar, encontré %. Nada se borró.',
      coalesce(array_length(v_ids, 1), 0);
  END IF;

  -- Guarda 1: ninguna puede tener servicios colgando, ni ella ni sus hijas.
  SELECT count(*) INTO v_n
  FROM service_category sc
  WHERE sc.category_id = ANY(v_ids)
     OR sc.category_id IN (SELECT id FROM categories WHERE parent_category_id = ANY(v_ids));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Hay % servicios colgando de estas categorías. Nada se borró.', v_n;
  END IF;

  -- Guarda 2: nadie más las referencia. Son FK NO ACTION, así que un borrado
  -- a ciegas fallaría a mitad de camino en vez de avisar acá.
  SELECT string_agg(t, ', ') INTO v_sobra FROM (
    SELECT 'combos.area_category_id' AS t
      FROM combos WHERE area_category_id = ANY(v_ids)
    UNION
    SELECT 'area_pack_policy.area_category_id'
      FROM area_pack_policy WHERE area_category_id = ANY(v_ids)
    UNION
    -- Nietas: el borrado sólo contempla un nivel de hijas.
    SELECT 'categories (nietas)'
      FROM categories
     WHERE parent_category_id IN (SELECT id FROM categories WHERE parent_category_id = ANY(v_ids))
  ) s;
  IF v_sobra IS NOT NULL THEN
    RAISE EXCEPTION 'Todavía las referencia: %. Nada se borró.', v_sobra;
  END IF;

  -- Hijas primero (hoy sólo "Nutrición", bajo "General"), después las raíces.
  DELETE FROM categories WHERE parent_category_id = ANY(v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Subcategorías borradas: %', v_n;

  DELETE FROM categories WHERE id = ANY(v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Clasificaciones borradas: %', v_n;

  RAISE NOTICE 'Quedan % clasificaciones (categorías sin padre que no son áreas).',
    (SELECT count(*) FROM categories WHERE parent_category_id IS NULL AND kind <> 'area');
END $$;

-- Verificación (correr aparte, después de aplicar):
-- SELECT kind, name FROM categories WHERE parent_category_id IS NULL ORDER BY kind, name;
-- Esperado: 6 áreas + 8 clasificaciones (Aparatología, Belleza, Estética
-- Corporal, Manicuría y Pedicuría, Masajes, Promos del Mes, Tratamientos
-- Faciales, Tratamientos Médicos).
