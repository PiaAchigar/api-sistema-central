-- ════════════════════════════════════════════════════════════════════════════
-- 1.72.0 / 02 — Usuarios: borrar las filas viejas del seed y cargar nombres
-- (migración de DATOS — correr DESPUÉS de 1.72.0/01 y del backup)
-- ════════════════════════════════════════════════════════════════════════════
-- `public.users` tenía dos grupos de filas que nunca se juntaron:
--   · 9 filas cargadas a mano en junio: con full_name, SIN login (auth_id NULL).
--     Verificado en producción el 2026-11-13: ninguna tabla las referencia.
--   · 5 filas creadas desde Configuración → Usuarios: con login, SIN full_name.
--     Por eso el selector de asignación del CRM mostraba e-mails.
--
-- 1) Borra las 9 filas viejas (lista cerrada de IDs), pero sólo si siguen sin
--    login y sin ninguna referencia: la guarda revisa todas las FK que apuntan a
--    public.users (leídas de pg_constraint). Las que tengan algo se dejan y se
--    informan.
-- 2) Carga full_name en las filas con login, por e-mail (nombres confirmados
--    por Pia el 2026-11-13).
--
-- Un único bloque DO (el SQL Editor de Supabase hace autocommit por sentencia).
-- Idempotente: la segunda corrida no borra nada y vuelve a dejar los mismos nombres.
-- El editor no muestra los RAISE NOTICE: "Success. No rows returned" es lo esperado.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_viejas uuid[] := ARRAY[
    'f7d0acce-1f10-48ea-b5e9-040300fefaa3', -- Laura
    '53f85e96-4baa-470a-9b97-fe7d7ab2de8d', -- Micaela
    '50cdadee-1caf-4285-a36a-2f816a9899a8', -- Sofía
    '5db00da2-59a2-4dd9-9dde-dc85df21e536', -- Micaela P
    '90a05c5f-b6c4-4fa1-ac7c-9999d95d33f4', -- Agostina
    'cca2106d-e099-4847-ad00-21d619111c12', -- Cami
    '7a601e7e-c874-414c-9481-2ceb5bbfff50', -- Cande
    'e78ba96c-e9bb-4790-bf46-dd43ad3142c2', -- Evan
    '6f4aa652-3807-42ec-a948-26e08563bd56'  -- Lucía (lulycelano@, sin login)
  ]::uuid[];
  v_id uuid;
  v_fk record;
  v_refs bigint;
  v_total bigint;
  v_borradas integer := 0;
  v_nombres integer;
BEGIN
  FOREACH v_id IN ARRAY v_viejas LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_id AND auth_id IS NULL);
    v_total := 0;
    FOR v_fk IN
      SELECT c.conrelid::regclass::text AS tabla, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass
    LOOP
      EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', v_fk.tabla, v_fk.col)
        INTO v_refs USING v_id;
      v_total := v_total + v_refs;
    END LOOP;
    IF v_total > 0 THEN
      RAISE NOTICE '1.72.0/02: se deja % (tiene % referencias)', v_id, v_total;
    ELSE
      DELETE FROM public.users WHERE id = v_id;
      v_borradas := v_borradas + 1;
    END IF;
  END LOOP;

  UPDATE public.users u
  SET full_name = n.nombre, updated_at = now()
  FROM (VALUES
    ('lauradaruda@gmail.com',      'Laura Daruda'),
    ('lulycelano@gmail.com',       'Lucía Celano'),
    ('luriquelme2007@gmail.com',   'Lucía Riquelme'),
    ('sofiaceballos367@gmail.com', 'Sofía Ceballos'),
    ('rios.agos20@gmail.com',      'Agostina Ríos')
  ) AS n(email, nombre)
  WHERE u.email = n.email AND u.auth_id IS NOT NULL;
  GET DIAGNOSTICS v_nombres = ROW_COUNT;

  RAISE NOTICE '1.72.0/02: % filas viejas borradas, % nombres cargados', v_borradas, v_nombres;
END $$;

-- Verificación (correr aparte): tienen que quedar sólo filas con login y con nombre.
-- SELECT full_name, email, role, is_active, auth_id IS NOT NULL AS con_login
-- FROM public.users ORDER BY full_name;
