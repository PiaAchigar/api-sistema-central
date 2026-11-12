-- ════════════════════════════════════════════════════════════════════════════
-- 1.71.0 / 03 — Limpieza de contactos sin teléfono (migración de DATOS, BORRA)
-- ════════════════════════════════════════════════════════════════════════════
-- Correr el backup de backup/ antes.
--
-- Candidatos: contactos con phone NULL o con menos de 10 dígitos.
--   · Si NADA los referencia (ni a ellos ni a su fila de customers): se borra el
--     customer y después el contacto.
--   · Si algo los referencia (factura, turno, pago, nota, deal, conversación,
--     a cargo de otra persona, saldo a favor, canal de contacto, etc.): se conservan y se les agrega
--     el tag 'sin-telefono' (si no lo tenían).
--
-- "Referenciar" se arma EN EL MOMENTO DE CORRER, desde el catálogo:
--   1. toda FK (pg_constraint, contype='f') hacia contacts y hacia customers
--      (menos customers.contact_id, que es la fila que se borra junto con el
--      contacto);
--   2. toda columna contact_id / customer_id de cualquier tabla que NO tenga FK
--      (hoy: automation_runs.contact_id), por information_schema.columns;
--   3. customers.credit_balance <> 0;
--   4. canal de contacto propio: whatsapp_id, instagram_id, facebook_id o
--      telegram_id no vacíos (quien tiene cómo ser contactado por un canal no se
--      borra). Email y notas NO protegen.
-- Una FK compuesta hacia contacts/customers frena la migración (no se sabe
-- comprobarla): mejor no borrar nada que borrar mal.
-- Un único bloque DO: corre entero o no corre. Idempotente.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_fk          record;
  v_sql         text := 'SELECT false';
  v_cand        record;
  v_clientes    uuid[];
  v_referenciado boolean;
  v_borrados    integer := 0;
  v_etiquetados integer := 0;
  v_conservados integer := 0;
BEGIN
  -- 1. FK hacia contacts (el id del contacto va en $1)
  FOR v_fk IN
    SELECT con.conrelid::regclass AS tabla, a.attname AS columna, cardinality(con.conkey) AS ncols
    FROM pg_constraint con
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'f' AND con.confrelid = 'public.contacts'::regclass
  LOOP
    IF v_fk.ncols <> 1 THEN
      RAISE EXCEPTION 'FK compuesta hacia contacts en %: no se sabe comprobarla, no se borra nada', v_fk.tabla;
    END IF;
    IF v_fk.tabla = 'public.customers'::regclass AND v_fk.columna = 'contact_id' THEN
      CONTINUE;  -- es la fila de customers que se borra junto con el contacto
    END IF;
    v_sql := v_sql || format(' OR EXISTS (SELECT 1 FROM %s WHERE %I = $1)', v_fk.tabla, v_fk.columna);
  END LOOP;

  -- 1b. FK hacia customers (los ids de sus customers van en $2)
  FOR v_fk IN
    SELECT con.conrelid::regclass AS tabla, a.attname AS columna, cardinality(con.conkey) AS ncols
    FROM pg_constraint con
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'f' AND con.confrelid = 'public.customers'::regclass
  LOOP
    IF v_fk.ncols <> 1 THEN
      RAISE EXCEPTION 'FK compuesta hacia customers en %: no se sabe comprobarla, no se borra nada', v_fk.tabla;
    END IF;
    v_sql := v_sql || format(' OR EXISTS (SELECT 1 FROM %s WHERE %I = ANY($2))', v_fk.tabla, v_fk.columna);
  END LOOP;

  -- 2. Columnas contact_id / customer_id SIN FK (comparadas como texto)
  FOR v_fk IN
    SELECT format('%I.%I', c.table_schema, c.table_name) AS tabla, c.column_name AS columna
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_name IN ('contact_id', 'customer_id')
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint con
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
        WHERE con.contype = 'f'
          AND con.conrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
          AND a.attname = c.column_name)
  LOOP
    IF v_fk.columna = 'contact_id' THEN
      v_sql := v_sql || format(' OR EXISTS (SELECT 1 FROM %s WHERE %I::text = $1::text)', v_fk.tabla, v_fk.columna);
    ELSE
      v_sql := v_sql || format(' OR EXISTS (SELECT 1 FROM %s WHERE %I::text = ANY($2::text[]))', v_fk.tabla, v_fk.columna);
    END IF;
    RAISE NOTICE 'columna sin FK comprobada: %.%', v_fk.tabla, v_fk.columna;
  END LOOP;

  -- 3. Saldo a favor
  v_sql := v_sql || ' OR EXISTS (SELECT 1 FROM public.customers WHERE id = ANY($2) AND credit_balance <> 0)';

  -- Recorrido de candidatos
  FOR v_cand IN
    SELECT c.id, COALESCE(c.tags, '{}'::text[]) AS tags,
           (COALESCE(btrim(c.whatsapp_id), '') <> '' OR COALESCE(btrim(c.instagram_id), '') <> ''
            OR COALESCE(btrim(c.facebook_id), '') <> '' OR COALESCE(btrim(c.telegram_id), '') <> '') AS tiene_canal
    FROM public.contacts c
    WHERE c.phone IS NULL OR length(regexp_replace(c.phone, '\D', '', 'g')) < 10
  LOOP
    SELECT COALESCE(array_agg(cu.id), '{}'::uuid[]) INTO v_clientes
    FROM public.customers cu WHERE cu.contact_id = v_cand.id;

    EXECUTE v_sql INTO v_referenciado USING v_cand.id, v_clientes;

    IF NOT v_referenciado AND NOT v_cand.tiene_canal THEN
      DELETE FROM public.customers WHERE id = ANY(v_clientes);  -- primero el customer
      DELETE FROM public.contacts WHERE id = v_cand.id;
      v_borrados := v_borrados + 1;
    ELSIF NOT ('sin-telefono' = ANY (v_cand.tags)) THEN
      UPDATE public.contacts SET tags = array_append(v_cand.tags, 'sin-telefono') WHERE id = v_cand.id;
      v_etiquetados := v_etiquetados + 1;
    ELSE
      v_conservados := v_conservados + 1;
    END IF;
  END LOOP;

  RAISE NOTICE '1.71.0/03: borrados: %, etiquetados sin-telefono: %, ya etiquetados: %',
    v_borrados, v_etiquetados, v_conservados;
END $$;

-- Verificación (correr aparte): los que quedan sin teléfono tienen que estar
-- todos etiquetados, y ninguno tiene que poder borrarse.
-- SELECT count(*) AS sin_telefono, count(*) FILTER (WHERE 'sin-telefono' = ANY (tags)) AS etiquetados
-- FROM public.contacts
-- WHERE phone IS NULL OR length(regexp_replace(phone, '\D', '', 'g')) < 10;
