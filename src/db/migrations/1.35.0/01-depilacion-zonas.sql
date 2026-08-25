-- ════════════════════════════════════════════════════════════════════════════
-- 1.35.0 / 01 — Depilación definitiva: zonas, precios y combos
-- ════════════════════════════════════════════════════════════════════════════
-- UNA SOLA SENTENCIA. El SQL Editor de Supabase hace autocommit por sentencia:
-- si esto fueran 20 sentencias, un error en la 12 dejaría la base a medio armar
-- (pasó de verdad con la 1.34.0). Por eso todo va en un único bloque DO, sin
-- `CREATE TEMP TABLE ... ON COMMIT DROP` (la temporal se destruye antes de que
-- la sentencia siguiente pueda verla) y sin `\echo` (meta-comando de psql, el
-- editor de Supabase no lo entiende).
--
-- Qué crea:
--   1. `body_zone`                 — catálogo de 24 zonas del cuerpo, con
--                                    categoría de tamaño (grande/mediana/chica)
--   2. `zone_exclusion`             — pares de zonas que no tiene sentido vender
--                                    juntas (una incluye a la otra)
--   3. `depilation_pricing_config`  — fila única con los parámetros de precio y
--                                    duración de sesión (PDF §§2,3,4,7,8)
--   4. `depilation_combo`           — los packs fijos y combos "guardados"
--   5. `depilation_combo_zone`      — qué zonas trae cada combo
--
-- Y de paso borra de `service` las 26 filas que representan zonas del cuerpo
-- cargadas como si fueran servicios sueltos (mismo criterio que 1.34.0):
-- ahora esas zonas viven en `body_zone` y su precio se calcula con
-- `depilation_pricing_config`, no con `service.unit_price_list`.
--
-- En la base LOCAL esas 26 filas no existen (son de producción): el bloque de
-- borrado va a loguear "nada que migrar" y eso es el resultado correcto, no
-- un fallo.
--
-- Idempotente: `CREATE TABLE IF NOT EXISTS` + `ON CONFLICT DO NOTHING` en todos
-- los inserts. Correrla dos veces contra la misma base no duplica nada — cosa
-- que ya pasó de verdad con la 1.34.0 (error a mitad en el SQL Editor de
-- Supabase, la usuaria la volvió a pegar). Para que `ON CONFLICT DO NOTHING`
-- tenga algo contra qué chocar, las 5 tablas necesitan un índice único de
-- arbitraje sobre las columnas que definen "la misma fila": `body_zone` lo
-- tiene parcial sobre `lower(name)`, `zone_exclusion` con
-- `ux_zone_exclusion (zone_id, excludes_zone_id)`, `depilation_pricing_config`
-- con `ux_dpc_singleton (singleton)`, `depilation_combo_zone` con
-- `ux_dcz (combo_id, zone_id)` — y `depilation_combo` con
-- `ux_depilation_combo_name (name)`: sin esa constraint, el `id` (siempre un
-- `gen_random_uuid()` nuevo) es la única PK y nunca choca, así que una
-- segunda pasada insertaría los 3 packs de nuevo.

DO $$
DECLARE
  serv_borrar uuid[];
  n_turnos    int;
  n_facturas  int;
BEGIN
  -- ── 1. Tablas ──────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS body_zone (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          varchar(100) NOT NULL,
    category      varchar(10)  NOT NULL,
    display_order integer      NOT NULL DEFAULT 0,
    is_active     boolean      NOT NULL DEFAULT true,
    created_at    timestamp    NOT NULL DEFAULT now(),
    updated_at    timestamp    NOT NULL DEFAULT now(),
    CONSTRAINT ck_body_zone_category CHECK (category IN ('grande','mediana','chica'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_body_zone_name
    ON body_zone (lower(name)) WHERE is_active;

  CREATE TABLE IF NOT EXISTS zone_exclusion (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_id          uuid NOT NULL REFERENCES body_zone(id) ON DELETE CASCADE,
    excludes_zone_id uuid NOT NULL REFERENCES body_zone(id) ON DELETE CASCADE,
    CONSTRAINT ck_zone_exclusion_distinta CHECK (zone_id <> excludes_zone_id),
    CONSTRAINT ux_zone_exclusion UNIQUE (zone_id, excludes_zone_id)
  );

  CREATE TABLE IF NOT EXISTS depilation_pricing_config (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    singleton                   boolean NOT NULL DEFAULT true,
    price_grande                integer NOT NULL,
    price_mediana               integer NOT NULL,
    price_chica                 integer NOT NULL,
    pricing_minutes_grande      integer NOT NULL,
    pricing_minutes_mediana     integer NOT NULL,
    pricing_minutes_chica       integer NOT NULL,
    tier1_rate_per_minute       integer NOT NULL,
    tier2_rate_per_minute       integer NOT NULL,
    slot_minutes_female_grande  integer NOT NULL,
    slot_minutes_female_mediana integer NOT NULL,
    slot_minutes_female_chica   integer NOT NULL,
    slot_minutes_male_grande    integer NOT NULL,
    slot_minutes_male_mediana   integer NOT NULL,
    slot_minutes_male_chica     integer NOT NULL,
    slot_rounding_step          integer NOT NULL,
    slot_minimum_minutes        integer NOT NULL,
    pack_sessions               integer NOT NULL,
    pack_discount_percentage    integer NOT NULL,
    pack_rounding_base          integer NOT NULL,
    updated_at                  timestamp NOT NULL DEFAULT now(),
    CONSTRAINT ck_dpc_singleton CHECK (singleton),
    CONSTRAINT ux_dpc_singleton UNIQUE (singleton)
  );

  CREATE TABLE IF NOT EXISTS depilation_combo (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                   varchar(200) NOT NULL,
    description            text,
    kind                   varchar(20)  NOT NULL,
    fixed_price            numeric(10,2),
    fixed_duration_minutes integer,
    choice_zone_count      integer NOT NULL DEFAULT 0,
    is_published_web       boolean NOT NULL DEFAULT false,
    display_order          integer NOT NULL DEFAULT 0,
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamp NOT NULL DEFAULT now(),
    updated_at             timestamp NOT NULL DEFAULT now(),
    CONSTRAINT ck_dc_kind CHECK (kind IN ('pack_fijo','guardado')),
    CONSTRAINT ck_dc_precio_pack CHECK (kind <> 'pack_fijo' OR fixed_price IS NOT NULL),
    CONSTRAINT ck_dc_precio_guardado CHECK (kind <> 'guardado' OR fixed_price IS NULL),
    CONSTRAINT ck_dc_eleccion CHECK (choice_zone_count >= 0),
    CONSTRAINT ux_depilation_combo_name UNIQUE (name)
  );

  CREATE TABLE IF NOT EXISTS depilation_combo_zone (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    combo_id uuid NOT NULL REFERENCES depilation_combo(id) ON DELETE CASCADE,
    zone_id  uuid NOT NULL REFERENCES body_zone(id),
    CONSTRAINT ux_dcz UNIQUE (combo_id, zone_id)
  );

  -- ── 2. Seed de zonas (24) ──────────────────────────────────────────────
  INSERT INTO body_zone (name, category, display_order) VALUES
    ('Pierna entera','grande',1), ('Brazos','grande',2), ('Espalda','grande',3),
    ('Glúteos','grande',4), ('Rostro completo','grande',5),
    ('Media pierna','mediana',1), ('Medio brazo','mediana',2),
    ('Espalda alta','mediana',3), ('Espalda baja','mediana',4),
    ('Abdomen','mediana',5), ('Pecho','mediana',6), ('Cavado completo','mediana',7),
    ('Axila','chica',1), ('Cavado','chica',2), ('Tira de cola','chica',3),
    ('Bozo','chica',4), ('Sub mentón / mentón','chica',5), ('Patillas','chica',6),
    ('Línea alba','chica',7), ('Empeine y dedos de los pies','chica',8),
    ('Pelvis','chica',9), ('Barba','chica',10), ('Hombros','chica',11),
    ('Antebrazo','chica',12)
  ON CONFLICT DO NOTHING;

  -- ── 3. Exclusiones: 8 pares, las dos direcciones ───────────────────────
  -- Las 6 primeras salen del PDF §9. Espalda↔Espalda alta y
  -- Cavado↔Cavado completo se agregan por el mismo criterio: el PDF no las
  -- nombraba porque esas zonas no existían todavía.
  INSERT INTO zone_exclusion (zone_id, excludes_zone_id)
  SELECT a.id, b.id FROM (VALUES
      ('Pierna entera','Media pierna'),
      ('Brazos','Medio brazo'),
      ('Espalda','Espalda baja'),
      ('Espalda','Espalda alta'),
      ('Cavado completo','Cavado'),
      ('Rostro completo','Bozo'),
      ('Rostro completo','Sub mentón / mentón'),
      ('Rostro completo','Patillas')
    ) AS p(x,y)
  CROSS JOIN LATERAL (SELECT id FROM body_zone WHERE name = p.x) a
  CROSS JOIN LATERAL (SELECT id FROM body_zone WHERE name = p.y) b
  ON CONFLICT DO NOTHING;

  INSERT INTO zone_exclusion (zone_id, excludes_zone_id)
  SELECT excludes_zone_id, zone_id FROM zone_exclusion
  ON CONFLICT DO NOTHING;

  -- ── 4. Config (PDF §§2,3,4,7,8) ────────────────────────────────────────
  INSERT INTO depilation_pricing_config (
    price_grande, price_mediana, price_chica,
    pricing_minutes_grande, pricing_minutes_mediana, pricing_minutes_chica,
    tier1_rate_per_minute, tier2_rate_per_minute,
    slot_minutes_female_grande, slot_minutes_female_mediana, slot_minutes_female_chica,
    slot_minutes_male_grande, slot_minutes_male_mediana, slot_minutes_male_chica,
    slot_rounding_step, slot_minimum_minutes,
    pack_sessions, pack_discount_percentage, pack_rounding_base
  ) VALUES (19000,17000,12000, 10,7,5, 1200,1000, 9,6,3, 10,8,5, 5,10, 3,15,1000)
  ON CONFLICT DO NOTHING;

  -- ── 5. Los 3 packs fijos (PDF §6) ──────────────────────────────────────
  -- "cola" en el PDF es la abreviatura de axila + cavado + tira de cola.
  INSERT INTO depilation_combo (name, kind, fixed_price, choice_zone_count, display_order)
  VALUES ('Cuerpo Full','pack_fijo',65000,0,1),
         ('Cuerpo Completo','pack_fijo',58000,1,2),
         ('Combo de Esenciales','pack_fijo',49000,1,3)
  ON CONFLICT DO NOTHING;

  INSERT INTO depilation_combo_zone (combo_id, zone_id)
  SELECT c.id, z.id FROM (VALUES
      -- Cuerpo Full: 5 grandes + 5 chicas → fórmula $86.000, pack $65.000
      ('Cuerpo Full','Pierna entera'), ('Cuerpo Full','Rostro completo'),
      ('Cuerpo Full','Espalda'), ('Cuerpo Full','Brazos'), ('Cuerpo Full','Glúteos'),
      ('Cuerpo Full','Axila'), ('Cuerpo Full','Cavado'), ('Cuerpo Full','Tira de cola'),
      ('Cuerpo Full','Línea alba'), ('Cuerpo Full','Empeine y dedos de los pies'),
      -- Cuerpo Completo: 6 base + 1 a elección → fórmula $61.000, pack $58.000
      ('Cuerpo Completo','Pierna entera'), ('Cuerpo Completo','Rostro completo'),
      ('Cuerpo Completo','Glúteos'), ('Cuerpo Completo','Axila'),
      ('Cuerpo Completo','Cavado'), ('Cuerpo Completo','Tira de cola'),
      -- Combo de Esenciales: 5 base + 1 a elección → fórmula $51.000, pack $49.000
      ('Combo de Esenciales','Pierna entera'), ('Combo de Esenciales','Rostro completo'),
      ('Combo de Esenciales','Axila'), ('Combo de Esenciales','Cavado'),
      ('Combo de Esenciales','Tira de cola')
    ) AS p(combo, zona)
  CROSS JOIN LATERAL (SELECT id FROM depilation_combo WHERE name = p.combo) c
  CROSS JOIN LATERAL (SELECT id FROM body_zone       WHERE name = p.zona)  z
  ON CONFLICT DO NOTHING;

  -- ── 6. Guarda: abortar si las filas a borrar tienen historial ──────────
  SELECT array_agg(id) INTO serv_borrar FROM service WHERE name IN (
    '1/2 Brazo','1/2 Brazo - MUJER','Abdomen','Antebrazo','Axila','Barba','Bozo',
    'Brazo Completo','Cavado','Cavado Completo','Espalda (incluye hombros)',
    'Espalda alta','Espalda baja','Espalda completa','Glúteos','Glúteos Hombre',
    'Hombros','Media Pierna','Pecho','Pecho Hombre','Pelvis',
    'Pierna entera - HOMBRE','Pierna Entera - MUJER','Pies','Rostro Completo',
    'Tira de cola');

  IF serv_borrar IS NULL THEN
    RAISE NOTICE 'No hay filas de zona en service: nada que migrar.';
  ELSIF array_length(serv_borrar,1) <> 26 THEN
    -- La lista de nombres de arriba tiene genéricos ('Axila', 'Espalda alta',
    -- 'Pecho', 'Barba') que a propósito podrían calzar con un servicio de
    -- estética que NO sea una de las 26 zonas de depilación migradas. Si el
    -- IN captura de más (o de menos, por un nombre que cambió) hay que
    -- revisar a mano antes de borrar nada — abortar es más seguro que
    -- adivinar cuáles de las filas encontradas son realmente zonas.
    RAISE EXCEPTION
      'ABORTA: se esperaban 26 filas de zona en service, se encontraron %. Revisar los nombres antes de borrar.',
      array_length(serv_borrar,1);
  ELSE
    SELECT count(*) INTO n_turnos   FROM appointments WHERE service_id = ANY(serv_borrar);
    SELECT count(*) INTO n_facturas FROM line_items   WHERE service_id = ANY(serv_borrar);
    IF n_turnos > 0 OR n_facturas > 0 THEN
      RAISE EXCEPTION
        'ABORTA: las filas de zona tienen historial (% turnos, % líneas de factura). Revisar antes de borrar.',
        n_turnos, n_facturas;
    END IF;

    -- ── 7. Borrado en orden (solo service_embeddings tiene CASCADE) ──────
    -- `provider_rates_per_hour` NO se borra acá: es una VIEW sobre
    -- `service_provider_service` (src/db/migrations/1.1.0/sync.sql), sin
    -- trigger INSTEAD OF — un DELETE contra ella falla con "cannot delete
    -- from view". Ya queda limpia sola al borrar la tabla base dos líneas
    -- arriba.
    DELETE FROM service_category   WHERE service_id = ANY(serv_borrar);
    DELETE FROM service_embeddings WHERE service_id = ANY(serv_borrar);
    DELETE FROM combo_service      WHERE service_id = ANY(serv_borrar);
    DELETE FROM service_machine    WHERE service_id = ANY(serv_borrar);
    DELETE FROM service_provider_service WHERE service_id = ANY(serv_borrar);
    DELETE FROM promotion_service  WHERE service_id = ANY(serv_borrar);
    DELETE FROM service WHERE id = ANY(serv_borrar);
    RAISE NOTICE 'Borradas % filas de zona de service.', array_length(serv_borrar,1);
  END IF;

  RAISE NOTICE 'Migración 1.35.0 aplicada.';
END $$;

-- Verificación (correr aparte, NO es parte de la migración):
-- SELECT category, count(*) FROM body_zone GROUP BY 1;              -- 5 / 7 / 12
-- SELECT count(*) FROM zone_exclusion;                              -- 16
-- SELECT count(*) FROM service WHERE is_active;                     -- 123
-- SELECT name, kind, fixed_price FROM depilation_combo;             -- 3 packs
