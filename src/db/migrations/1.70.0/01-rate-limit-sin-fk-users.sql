-- ════════════════════════════════════════════════════════════════════════════
-- 1.70.0 / 01 — rate_limit_buckets sin FK a public.users
-- ════════════════════════════════════════════════════════════════════════════
-- La 1.21.0 creó `rate_limit_buckets.user_id` con FK a `public.users(id)`. Pero
-- el user_id que guarda el limitador es el `sub` del JWT de Supabase, o sea un
-- id de `auth.users`, y ningún usuario que inicia sesión está en public.users
-- (verificado en producción el 2026-11-12: 7 de 7 afuera). Resultado: el INSERT
-- del limitador violaba la FK y TODO envío manual desde el Inbox del CRM
-- devolvía 500, antes de guardar el mensaje y antes de llegar a WhatsApp.
--
-- Se borra cualquier FK de la tabla (la de la 1.21.0 se llama `fk_user`, pero
-- se buscan por catálogo para no depender del nombre). La PK (user_id,
-- minute_key) queda igual: es la que hace el conteo por minuto.
-- Un único bloque DO: corre entero o no corre. Idempotente.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_fk text;
BEGIN
  FOR v_fk IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.rate_limit_buckets'::regclass AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE public.rate_limit_buckets DROP CONSTRAINT %I', v_fk);
    RAISE NOTICE 'rate_limit_buckets: FK % borrada', v_fk;
  END LOOP;
END $$;

-- Verificación (correr aparte): tiene que devolver 0 filas.
-- SELECT conname FROM pg_constraint
-- WHERE conrelid = 'public.rate_limit_buckets'::regclass AND contype = 'f';
