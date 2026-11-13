-- ════════════════════════════════════════════════════════════════════════════
-- 1.72.0 / 01 — users.created_by_user_id: quién dio de alta a cada usuario
-- ════════════════════════════════════════════════════════════════════════════
--   users.created_by_user_id   id local (public.users) del admin que lo creó.
--                              NULL = usuario anterior a esta columna, o creado
--                              por un admin sin fila local. Si se borra el
--                              creador, queda NULL.
-- Un único bloque DO: corre entero o no corre. Idempotente. Sin datos.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS created_by_user_id uuid NULL
      REFERENCES public.users(id) ON DELETE SET NULL;

  RAISE NOTICE '1.72.0: users.created_by_user_id listo';
END $$;

-- Verificación (correr aparte): 1 fila.
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'users' AND column_name = 'created_by_user_id';
