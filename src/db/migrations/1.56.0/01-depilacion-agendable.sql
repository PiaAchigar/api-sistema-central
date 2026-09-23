-- 1.56.0 — Agendar depilación definitiva
--
-- UN SOLO BLOQUE: el SQL Editor de Supabase hace autocommit por sentencia.
-- Si esto fueran nueve sentencias sueltas y la séptima fallara, la base
-- quedaría a medio migrar. Así corre entera o no corre.
DO $$
DECLARE
  v_ancla   uuid;
  v_faltan  int;
BEGIN
  -- ── §3.3b/c — El precio y los minutos de precio, por sexo ───────────────
  -- Los valores de hoy se copian a LAS DOS familias: el comportamiento no
  -- cambia solo. Laura ajusta los de hombre cuando quiera.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'depilation_pricing_config'
                    AND column_name = 'price_female_grande') THEN
    ALTER TABLE depilation_pricing_config
      ADD COLUMN price_female_grande            integer,
      ADD COLUMN price_female_mediana           integer,
      ADD COLUMN price_female_chica             integer,
      ADD COLUMN price_male_grande              integer,
      ADD COLUMN price_male_mediana             integer,
      ADD COLUMN price_male_chica               integer,
      ADD COLUMN pricing_minutes_female_grande  integer,
      ADD COLUMN pricing_minutes_female_mediana integer,
      ADD COLUMN pricing_minutes_female_chica   integer,
      ADD COLUMN pricing_minutes_male_grande    integer,
      ADD COLUMN pricing_minutes_male_mediana   integer,
      ADD COLUMN pricing_minutes_male_chica     integer;

    UPDATE depilation_pricing_config SET
      price_female_grande            = price_grande,
      price_female_mediana           = price_mediana,
      price_female_chica             = price_chica,
      price_male_grande              = price_grande,
      price_male_mediana             = price_mediana,
      price_male_chica               = price_chica,
      pricing_minutes_female_grande  = pricing_minutes_grande,
      pricing_minutes_female_mediana = pricing_minutes_mediana,
      pricing_minutes_female_chica   = pricing_minutes_chica,
      pricing_minutes_male_grande    = pricing_minutes_grande,
      pricing_minutes_male_mediana   = pricing_minutes_mediana,
      pricing_minutes_male_chica     = pricing_minutes_chica;

    ALTER TABLE depilation_pricing_config
      ALTER COLUMN price_female_grande            SET NOT NULL,
      ALTER COLUMN price_female_mediana           SET NOT NULL,
      ALTER COLUMN price_female_chica             SET NOT NULL,
      ALTER COLUMN price_male_grande              SET NOT NULL,
      ALTER COLUMN price_male_mediana             SET NOT NULL,
      ALTER COLUMN price_male_chica               SET NOT NULL,
      ALTER COLUMN pricing_minutes_female_grande  SET NOT NULL,
      ALTER COLUMN pricing_minutes_female_mediana SET NOT NULL,
      ALTER COLUMN pricing_minutes_female_chica   SET NOT NULL,
      ALTER COLUMN pricing_minutes_male_grande    SET NOT NULL,
      ALTER COLUMN pricing_minutes_male_mediana   SET NOT NULL,
      ALTER COLUMN pricing_minutes_male_chica     SET NOT NULL;

    RAISE NOTICE 'depilation_pricing_config: 12 columnas por sexo creadas y copiadas';
  END IF;

  -- Las columnas viejas (price_grande, pricing_minutes_grande, ...) se
  -- CONSERVAN sin uso. Borrarlas es una migración aparte, después de
  -- verificar en producción que nada las lee.

  -- ── §3.3a — El sexo vive en el contacto ─────────────────────────────────
  -- NULL permitido y NULL = mujer. No se le inventa un valor a 3 mil
  -- contactos que nadie clasificó.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'contacts' AND column_name = 'sexo') THEN
    ALTER TABLE contacts ADD COLUMN sexo varchar(10);
    ALTER TABLE contacts ADD CONSTRAINT ck_contacts_sexo
      CHECK (sexo IS NULL OR sexo IN ('mujer', 'hombre'));
    RAISE NOTICE 'contacts.sexo: creada';
  END IF;

  -- ── §4 — El marcador del servicio ancla ─────────────────────────────────
  -- NO se reusa `is_visible`, que significa "visible en la web" y es otra
  -- cosa: un servicio puede ser vendible y no estar publicado.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'service' AND column_name = 'no_vendible') THEN
    ALTER TABLE service ADD COLUMN no_vendible boolean NOT NULL DEFAULT false;
    RAISE NOTICE 'service.no_vendible: creada';
  END IF;

  -- ── §9 — El vencimiento de los packs de depilación ──────────────────────
  -- NULL = no vence, que es como se comportan todas las compras de hoy. No
  -- se le pone fecha retroactiva a nadie: nadie le vendió a esa clienta un
  -- plazo que no existía cuando compró.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'depilation_combo'
                    AND column_name = 'validity_months') THEN
    ALTER TABLE depilation_combo ADD COLUMN validity_months integer;
    ALTER TABLE depilation_combo ADD CONSTRAINT ck_dc_vigencia
      CHECK (validity_months IS NULL OR validity_months > 0);
    RAISE NOTICE 'depilation_combo.validity_months: creada';
  END IF;

  -- ── §5 — Las zonas de cada turno ────────────────────────────────────────
  -- `minutos` se congela igual que `customer_purchase_service.price`: si
  -- mañana Laura cambia la config, un turno viejo no puede cambiar de
  -- duración solo.
  CREATE TABLE IF NOT EXISTS appointment_body_zone (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id uuid    NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    body_zone_id   uuid    NOT NULL REFERENCES body_zone(id),
    minutos        integer NOT NULL,
    created_at     timestamp NOT NULL DEFAULT now(),
    CONSTRAINT ux_abz_fila UNIQUE (appointment_id, body_zone_id),
    CONSTRAINT ck_abz_minutos CHECK (minutos > 0)
  );
  CREATE INDEX IF NOT EXISTS ix_abz_appointment ON appointment_body_zone(appointment_id);
  RAISE NOTICE 'appointment_body_zone: lista';

  -- ── §4 — La fila ancla ──────────────────────────────────────────────────
  -- Idempotente por nombre: re-pegar la migración no duplica el ancla.
  SELECT id INTO v_ancla FROM service WHERE name = 'Depilación Definitiva' AND no_vendible;

  IF v_ancla IS NULL THEN
    -- `service.id` no tiene DEFAULT a nivel Postgres (se genera en runtime
    -- vía Drizzle, ver el comentario sobre `$defaultFn` en schema/agenda.ts
    -- y migrations/1.0.0/init.sql): sin proveerlo acá, el INSERT viola el
    -- NOT NULL de la columna. gen_random_uuid() ya está disponible (se usa
    -- más abajo para appointment_body_zone).
    INSERT INTO service (id, name, description, unit_price_list, requires_machine,
                         requires_operator, estimated_duration_minutes,
                         is_active, is_visible, no_vendible)
    VALUES (gen_random_uuid(), 'Depilación Definitiva',
            'Servicio ancla: no se vende. Sostiene las proveedoras habilitadas, '
            || 'la máquina y sus tarifas para que la agenda de depilación funcione.',
            0, true, true, 30, true, false, true)
    RETURNING id INTO v_ancla;
    RAISE NOTICE 'service ancla creada: %', v_ancla;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'depilation_pricing_config'
                    AND column_name = 'anchor_service_id') THEN
    ALTER TABLE depilation_pricing_config
      ADD COLUMN anchor_service_id uuid REFERENCES service(id);
    RAISE NOTICE 'depilation_pricing_config.anchor_service_id: creada';
  END IF;

  UPDATE depilation_pricing_config SET anchor_service_id = v_ancla WHERE singleton;

  -- Guarda: si el ancla no quedó apuntada, nada de la agenda de depilación
  -- va a funcionar y el error aparecería recién en runtime.
  SELECT count(*) INTO v_faltan
    FROM depilation_pricing_config WHERE singleton AND anchor_service_id IS NULL;
  IF v_faltan > 0 THEN
    RAISE EXCEPTION 'La config de depilación quedó sin servicio ancla. No se aplica nada.';
  END IF;

  RAISE NOTICE '1.56.0 aplicada.';
END $$;

-- Verificación, para correr APARTE después de aplicar:
--
-- SELECT price_female_grande, price_male_grande,
--        pricing_minutes_female_chica, pricing_minutes_male_chica,
--        anchor_service_id
--   FROM depilation_pricing_config;
-- SELECT id, name, no_vendible FROM service WHERE no_vendible;
-- SELECT count(*) FROM appointment_body_zone;
