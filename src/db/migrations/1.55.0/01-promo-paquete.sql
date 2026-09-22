-- 1.55.0 — La promo que se vende como una cosa (paquete)
--
-- UN SOLO BLOQUE: el SQL Editor de Supabase hace autocommit por sentencia.
-- Si esto fueran 8 sentencias sueltas y la sexta fallara, la base quedaría a
-- medio migrar. Así corre entera o no corre.
DO $$
DECLARE
  v_sin_identidad  int;
  v_violarian      int;
BEGIN
  -- ── §4.1 El precio del paquete ──────────────────────────────────────────
  -- NULL para las promos de descuento. Obligatorio para las de paquete, y eso
  -- lo valida la API: el tipo y el precio se escriben en la misma sentencia,
  -- así que un CHECK cruzado complicaría el update sin agregar seguridad.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'promotions' AND column_name = 'precio_del_paquete') THEN
    ALTER TABLE promotions ADD COLUMN precio_del_paquete numeric(12,2);
    RAISE NOTICE 'promotions.precio_del_paquete: creada';
  END IF;

  -- ── §4.2 Cuántas veces entra cada cosa en el paquete ────────────────────
  -- "3 limpiezas de cutis" es UNA fila con cantidad = 3, no tres filas: el
  -- UNIQUE ux_pt ya impide repetir la misma cosa en la misma promo.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'promotion_target' AND column_name = 'cantidad') THEN
    ALTER TABLE promotion_target ADD COLUMN cantidad integer NOT NULL DEFAULT 1;
    ALTER TABLE promotion_target ADD CONSTRAINT ck_pt_cantidad CHECK (cantidad >= 1);
    RAISE NOTICE 'promotion_target.cantidad: creada';
  END IF;

  -- ── §4.4 La línea comprada dice quién es ────────────────────────────────
  -- Hoy la identidad de una línea de depilación o capacitación vive en la
  -- CABECERA de la compra. En un paquete la cabecera ya no puede decirlo:
  -- podría haber dos packs distintos.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'customer_purchase_service'
                    AND column_name = 'depilation_combo_id') THEN
    ALTER TABLE customer_purchase_service
      ADD COLUMN depilation_combo_id uuid REFERENCES depilation_combo(id);
    RAISE NOTICE 'customer_purchase_service.depilation_combo_id: creada';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'customer_purchase_service'
                    AND column_name = 'training_id') THEN
    ALTER TABLE customer_purchase_service
      ADD COLUMN training_id uuid REFERENCES training(id);
    RAISE NOTICE 'customer_purchase_service.training_id: creada';
  END IF;

  -- Relleno de lo existente. Sin esto el CHECK de abajo no se puede crear:
  -- hoy hay filas con los tres campos en NULL.
  UPDATE customer_purchase_service cps
     SET depilation_combo_id = cp.depilation_combo_id
    FROM customer_purchase cp
   WHERE cp.id = cps.customer_purchase_id
     AND cps.service_id IS NULL
     AND cps.depilation_combo_id IS NULL
     AND cp.depilation_combo_id IS NOT NULL;

  UPDATE customer_purchase_service cps
     SET training_id = cp.training_id
    FROM customer_purchase cp
   WHERE cp.id = cps.customer_purchase_id
     AND cps.service_id IS NULL
     AND cps.training_id IS NULL
     AND cp.training_id IS NOT NULL;

  SELECT count(*) INTO v_sin_identidad
    FROM customer_purchase_service
   WHERE (service_id IS NOT NULL)::int
       + (depilation_combo_id IS NOT NULL)::int
       + (training_id IS NOT NULL)::int <> 1;

  IF v_sin_identidad > 0 THEN
    RAISE EXCEPTION
      'Quedan % filas de customer_purchase_service sin identidad única. No se aplica nada.',
      v_sin_identidad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_cpsv_identidad_unica') THEN
    ALTER TABLE customer_purchase_service
      ADD CONSTRAINT ck_cpsv_identidad_unica CHECK (
        (service_id IS NOT NULL)::int
      + (depilation_combo_id IS NOT NULL)::int
      + (training_id IS NOT NULL)::int = 1
      );
    RAISE NOTICE 'ck_cpsv_identidad_unica: creada';
  END IF;

  -- ── §4.3 La compra que es un paquete ────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'customer_purchase'
                    AND column_name = 'es_paquete_de_promo') THEN
    ALTER TABLE customer_purchase
      ADD COLUMN es_paquete_de_promo boolean NOT NULL DEFAULT false;
    RAISE NOTICE 'customer_purchase.es_paquete_de_promo: creada';
  END IF;

  -- El CHECK nuevo es EQUIVALENTE al viejo cuando es_paquete_de_promo = false,
  -- que es el default de todas las filas existentes. Se cuenta igual antes de
  -- tocar nada: si alguna violara, mejor un mensaje claro que el error crudo
  -- de Postgres.
  SELECT count(*) INTO v_violarian
    FROM customer_purchase
   WHERE NOT (
     CASE WHEN es_paquete_de_promo
       THEN combo_id IS NULL AND service_id IS NULL
        AND depilation_combo_id IS NULL AND training_id IS NULL
       ELSE (combo_id IS NOT NULL)::int + (service_id IS NOT NULL)::int
          + (depilation_combo_id IS NOT NULL)::int + (training_id IS NOT NULL)::int = 1
     END
   );

  IF v_violarian > 0 THEN
    RAISE EXCEPTION
      '% compras existentes no pasarían el CHECK nuevo. No se aplica nada.', v_violarian;
  END IF;

  ALTER TABLE customer_purchase DROP CONSTRAINT IF EXISTS ck_cpu_origen_unico;
  ALTER TABLE customer_purchase ADD CONSTRAINT ck_cpu_origen_unico CHECK (
    CASE WHEN es_paquete_de_promo
      -- Paquete: ningún origen suelto.
      --
      -- `promotion_id` NO se exige, y es a propósito: es ON DELETE SET NULL
      -- desde la 1.53.0, así que si Laura borra la promo la compra se queda
      -- con NULL. Exigirlo pasaría la primera vez y lo violaría la segunda.
      -- Quién era queda en `promotion_name`, congelado al vender.
      THEN combo_id IS NULL AND service_id IS NULL
       AND depilation_combo_id IS NULL AND training_id IS NULL
      -- Como hasta hoy: exactamente uno de los cuatro.
      ELSE (combo_id IS NOT NULL)::int + (service_id IS NOT NULL)::int
         + (depilation_combo_id IS NOT NULL)::int + (training_id IS NOT NULL)::int = 1
    END
  );
  RAISE NOTICE 'ck_cpu_origen_unico: reemplazado';

  RAISE NOTICE '1.55.0 aplicada.';
END $$;

-- Verificación, para correr APARTE después de aplicar:
--
-- SELECT count(*) FILTER (WHERE es_paquete_de_promo) AS paquetes,
--        count(*) AS compras
--   FROM customer_purchase;
-- SELECT count(*) FROM customer_purchase_service WHERE depilation_combo_id IS NOT NULL;
