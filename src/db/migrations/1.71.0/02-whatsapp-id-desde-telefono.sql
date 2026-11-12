-- ════════════════════════════════════════════════════════════════════════════
-- 1.71.0 / 02 — WhatsApp ID desde el teléfono (migración de DATOS)
-- ════════════════════════════════════════════════════════════════════════════
-- Correr el backup de backup/ antes.
-- NOTA: el SQL Editor de Supabase no muestra los RAISE NOTICE: 'Success. No rows returned' es lo
-- esperado; los conteos se ven corriendo la verificación comentada al final.
--
-- A cada contacto sin whatsapp_id (NULL o vacío) cuyo teléfono es un número
-- argentino válido se le carga whatsapp_id = '549' + últimos 10 dígitos, SIEMPRE
-- QUE ningún otro contacto comparta esa clave (últimos 10 dígitos del teléfono).
-- Los compartidos no se tocan: ahí Laura tiene que decidir quién es la titular.
-- Tampoco se carga un whatsapp_id que otro contacto ya tenga.
--
-- La regla de validez es la de src/lib/telefono.ts (`aWhatsappId`), escrita en SQL:
--   · se quita un `00` inicial (marca internacional)
--   · `54` + (9 + 10 dígitos | 10 dígitos), si venía con `00` o tiene 11+ dígitos
--   · si no, exactamente 10 dígitos que no empiecen con 0 ni con 15
--   · inválidos: 0 + área, área + 15 (12 dígitos), 15 + 8 dígitos, cortos, extranjeros
-- El test src/db/migrations/union-contactos-datos-1.71.test.ts compara esta regla
-- con la tabla de casos de telefono.test.ts.
-- Un único bloque DO (el editor de Supabase hace autocommit por sentencia).
-- Idempotente: la segunda corrida no encuentra nada que cargar.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_cargados integer;
BEGIN
  WITH base AS (
    SELECT c.id,
           regexp_replace(c.phone, '\D', '', 'g') AS d0
    FROM public.contacts c
    WHERE (c.whatsapp_id IS NULL OR c.whatsapp_id = '')
      AND c.phone IS NOT NULL
  ),
  norm AS (
    SELECT id,
           (d0 LIKE '00%') AS intl,
           CASE WHEN d0 LIKE '00%' THEN substr(d0, 3) ELSE d0 END AS d
    FROM base
  ),
  calc AS (
    SELECT id,
      CASE
        WHEN d LIKE '54%' AND (intl OR length(d) >= 11) THEN
          CASE
            WHEN length(d) = 13 AND substr(d, 3, 1) = '9' THEN '549' || substr(d, 4)
            WHEN length(d) = 12 THEN '549' || substr(d, 3)
            ELSE NULL
          END
        WHEN intl THEN NULL
        WHEN d LIKE '0%' THEN NULL
        WHEN length(d) = 12
             AND (substr(d, 3, 2) = '15' OR substr(d, 4, 2) = '15' OR substr(d, 5, 2) = '15') THEN NULL
        WHEN length(d) = 10 AND d LIKE '15%' THEN NULL
        WHEN length(d) = 10 THEN '549' || d
        ELSE NULL
      END AS wid
    FROM norm
  ),
  candidatos AS (
    SELECT id, wid FROM calc WHERE wid IS NOT NULL
  ),
  elegibles AS (
    SELECT k.id, k.wid
    FROM candidatos k
    WHERE NOT EXISTS (   -- ningún otro contacto comparte la clave del teléfono
            SELECT 1 FROM public.contacts o
            WHERE o.id <> k.id
              AND o.phone IS NOT NULL
              AND length(regexp_replace(o.phone, '\D', '', 'g')) >= 10
              AND right(regexp_replace(o.phone, '\D', '', 'g'), 10) = right(k.wid, 10))
      AND NOT EXISTS (   -- ni tiene ya ese WhatsApp ID
            SELECT 1 FROM public.contacts o
            WHERE o.id <> k.id AND o.whatsapp_id = k.wid)
  ),
  hechos AS (
    UPDATE public.contacts c
    SET whatsapp_id = e.wid
    FROM elegibles e
    WHERE c.id = e.id
    RETURNING c.id
  )
  SELECT count(*) INTO v_cargados FROM hechos;

  RAISE NOTICE '1.71.0/02: whatsapp_id cargado en % contactos', v_cargados;
END $$;

-- Verificación (correr aparte): con whatsapp_id, formato 549 + 10 dígitos.
-- SELECT count(*) FILTER (WHERE whatsapp_id ~ '^549[0-9]{10}$') AS con_whatsapp_id,
--        count(*) FILTER (WHERE whatsapp_id IS NULL OR whatsapp_id = '') AS sin_whatsapp_id
-- FROM public.contacts;
