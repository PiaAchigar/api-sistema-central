-- ═══════════════════════════════════════════════════════════════════════════
-- 1.32.0 — Limpiar restos de markdown en los textos de servicios
--
-- POR QUÉ EXISTE: la migración 1.29.0 pasó el contenido de los `batch_*.json`
-- a la base tal cual venía, y ese contenido traía markdown escapado. Como la
-- web muestra estos campos como texto plano, los marcadores se ven literales
-- en pantalla. En la home, la tarjeta de "Hidratación de Labios" mostraba:
--
--     \- se debe evaluar previamente la zona… \Este valor es para una zona…\
--
-- Son tres patrones, todos del mismo origen:
--   1. barras invertidas usadas como delimitador de énfasis  (\texto\)
--   2. barras invertidas escapando un guion de lista          (\-)
--   3. un encabezado markdown que quedó como texto            (### -)
--
-- Alcance real medido en producción: 3 servicios con barras y 1 con `###`.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Paso 1: sacar las barras invertidas ────────────────────────────────────
-- En LIKE la barra invertida es el carácter de escape por defecto, por eso el
-- patrón se escribe '%\\%' para buscar UNA barra literal.
UPDATE service SET
  benefits                = replace(benefits, '\', ''),
  special_attention_notes = replace(special_attention_notes, '\', ''),
  description             = replace(description, '\', ''),
  contraindications       = replace(contraindications, '\', '')
WHERE benefits                LIKE '%\\%'
   OR special_attention_notes LIKE '%\\%'
   OR description             LIKE '%\\%'
   OR contraindications       LIKE '%\\%';

-- ── Paso 2: sacar encabezados markdown que quedaron como texto ─────────────
-- Después del paso 1, "### \-Baby Botox:" quedó como "### -Baby Botox:".
UPDATE service SET
  benefits                = regexp_replace(benefits, '#{1,6}\s*-?\s*', '', 'g'),
  special_attention_notes = regexp_replace(special_attention_notes, '#{1,6}\s*-?\s*', '', 'g')
WHERE benefits LIKE '%##%' OR special_attention_notes LIKE '%##%';

-- ── Paso 3: guion de lista suelto al principio del campo ───────────────────
-- "- se debe evaluar…" queda como "Se debe evaluar…": sin el guion huérfano y
-- empezando con mayúscula, que es como se lee en la tarjeta.
UPDATE service SET
  benefits = upper(left(btrim(regexp_replace(benefits, '^\s*-\s*', '')), 1))
             || substring(btrim(regexp_replace(benefits, '^\s*-\s*', '')) from 2)
WHERE benefits ~ '^\s*-\s';

UPDATE service SET
  special_attention_notes =
    upper(left(btrim(regexp_replace(special_attention_notes, '^\s*-\s*', '')), 1))
    || substring(btrim(regexp_replace(special_attention_notes, '^\s*-\s*', '')) from 2)
WHERE special_attention_notes ~ '^\s*-\s';

-- ── Verificación ───────────────────────────────────────────────────────────
-- Después de correrla, esto tiene que dar 0 en las cuatro columnas:
--
-- SELECT count(*) FILTER (WHERE benefits LIKE '%\\%')                as barras_benefits,
--        count(*) FILTER (WHERE special_attention_notes LIKE '%\\%') as barras_notas,
--        count(*) FILTER (WHERE benefits LIKE '%##%')                as heading_benefits,
--        count(*) FILTER (WHERE benefits ~ '^\s*-\s')                as guion_suelto
-- FROM service;
