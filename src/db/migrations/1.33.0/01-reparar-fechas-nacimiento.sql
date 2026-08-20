-- ════════════════════════════════════════════════════════════════════════════
-- 1.33.0 / 01 — Reparar fechas de nacimiento importadas con siglo equivocado
-- ════════════════════════════════════════════════════════════════════════════
-- La importación original leyó los años en DOS dígitos con el pivote en 76:
-- "76".."99" → 1976..1999 (bien) y "00".."75" → 2000..2075 (mal para todo el
-- que nació antes de 1976). Resultado: 1403 de 5607 contactos con fecha —el
-- 25%— quedaron con fecha de nacimiento en el futuro.
--
-- Tres cosas confirman el diagnóstico contra los datos reales:
--   1. La fecha más vieja de TODA la base es 1976-01-01. No hay ni una anterior,
--      que es justo lo que produce un pivote en 76.
--   2. Restando 100 años, las 1403 quedan entre 1929-06-06 y 1975-12-23: cero
--      futuras y cero personas de más de 100 años.
--   3. Entre la última fecha pasada (2025-07-08) y la primera futura
--      (2029-06-06) hay un hueco de casi cuatro años sin un solo registro. El
--      límite no roza ningún dato, así que no hay caso ambiguo.
--
-- El corte va como fecha fija y no como CURRENT_DATE a propósito: así la
-- migración hace lo mismo hoy que dentro de cinco años. Las nacidas en
-- 2000..2025 NO se tocan: son clientas jóvenes reales, no 1900..1925.
--
-- Idempotente: después de correr no queda ninguna fecha >= 2026, así que un
-- segundo pase actualiza 0 filas.

\echo '── ANTES ──'
SELECT count(*) FILTER (WHERE birthdate >= DATE '2026-01-01') AS a_reparar,
       min(birthdate) FILTER (WHERE birthdate >= DATE '2026-01-01') AS mas_temprana,
       max(birthdate) AS mas_tardia
  FROM contacts;

UPDATE contacts
   SET birthdate  = birthdate - INTERVAL '100 years',
       updated_at = now()
 WHERE birthdate >= DATE '2026-01-01';

\echo '── DESPUÉS (las tres deben dar 0) ──'
SELECT count(*) FILTER (WHERE birthdate >= DATE '2026-01-01')        AS quedan_futuras,
       count(*) FILTER (WHERE birthdate > CURRENT_DATE)              AS quedan_por_venir,
       count(*) FILTER (WHERE birthdate < DATE '1900-01-01')         AS quedan_absurdas
  FROM contacts;

\echo '── rango final ──'
SELECT min(birthdate) AS mas_vieja, max(birthdate) AS mas_nueva,
       count(*) AS con_fecha
  FROM contacts WHERE birthdate IS NOT NULL;
