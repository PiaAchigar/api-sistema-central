-- 1.51.0 — El servicio comprado como unidad de consumo (V3b)
--
-- `customer_purchase_session` guardaba una fila por REPETICIÓN del pack, con
-- una sola columna `appointment_id`. Un combo de dos servicios necesita dos
-- turnos, así que no entraba: V3a lo dejó explícitamente afuera del consumo.
--
-- Acá la unidad pasa a ser el SERVICIO. Cada fila es un servicio comprado y
-- lleva su propio turno. Cuando lo tiene, ESA fila es una sesión — ver el
-- vocabulario en el spec 2026-09-11-servicios-comprados-v3b-design.md §2.
--
-- Las dos tablas viejas estaban VACÍAS en producción el 2026-09-11 (verificado
-- por psql), así que no hay backfill. La guarda de abajo es lo que lo vuelve
-- seguro si alguien vendió entre esa verificación y esta migración.
--
-- Un solo bloque DO: el SQL Editor de Supabase hace autocommit por sentencia y
-- a medio aplicar dejaría la base sin la tabla vieja y sin la nueva.
DO $$
DECLARE
  v_n integer;
BEGIN
  -- ══ 1. Guardas: si hay datos, no se toca nada ═════════════════════════════
  IF to_regclass('public.customer_purchase_session') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM customer_purchase_session;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'customer_purchase_session tiene % fila(s). Esta migración las borraría. Migralas a mano antes de correrla.', v_n;
    END IF;
  END IF;

  IF to_regclass('public.customer_purchase_session_service') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM customer_purchase_session_service;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'customer_purchase_session_service tiene % fila(s). Esta migración las borraría.', v_n;
    END IF;
  END IF;

  -- ══ 2. Se van las dos viejas ══════════════════════════════════════════════
  -- La hija primero: su FK `session_id` apunta a la otra.
  DROP TABLE IF EXISTS customer_purchase_session_service;
  DROP TABLE IF EXISTS customer_purchase_session;

  -- ══ 3. La nueva ═══════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS customer_purchase_service (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_purchase_id uuid NOT NULL REFERENCES customer_purchase(id) ON DELETE CASCADE,
    -- NULLABLE a propósito: un pack de depilación se compra por zonas y una
    -- capacitación es una sola cosa por visita. Esas compras generan una fila
    -- por repetición con service_id en NULL — no hay nada que desglosar.
    service_id           uuid REFERENCES service(id),
    -- Qué vuelta del pack. Hoy no la mira nadie; es lo que después le permite a
    -- V3c aplicar "Se hacen juntos" ("estas dos van el mismo día" necesita
    -- saber cuáles dos).
    repeticion           integer NOT NULL,
    -- Copias del MISMO servicio dentro de una vuelta, por
    -- combo_service.sessions_included. En la práctica siempre 1.
    orden                integer NOT NULL DEFAULT 1,
    appointment_id       uuid REFERENCES appointments(id),
    consumed_at          timestamp,
    notes                text,
    created_at           timestamp NOT NULL DEFAULT now(),
    updated_at           timestamp NOT NULL DEFAULT now(),
    CONSTRAINT ck_cpsv_repeticion CHECK (repeticion >= 1),
    CONSTRAINT ck_cpsv_orden CHECK (orden >= 1),
    -- Un turno no consume dos servicios. Nullable está bien: Postgres permite N
    -- filas con NULL en un índice único, así que los servicios sin agendar
    -- conviven. No hace falta "arreglarlo" con un índice parcial.
    CONSTRAINT ux_cpsv_turno UNIQUE (appointment_id),
    -- NULLS NOT DISTINCT (PostgreSQL 15+): sin eso cada NULL cuenta como
    -- distinto y la restricción no impediría duplicados justo en las filas que
    -- llevan service_id NULL. Prod es 17.6 y local 15.4: entra en las dos.
    CONSTRAINT ux_cpsv_fila UNIQUE NULLS NOT DISTINCT
      (customer_purchase_id, repeticion, service_id, orden)
  );

  -- NO tiene columna de estado, igual que la tabla que reemplaza: se deriva de
  -- consumed_at / appointment_id / el vencimiento de la compra. Un turno
  -- cancelado devuelve el servicio a "a agendar" sin que nadie escriba nada.

  CREATE INDEX IF NOT EXISTS ix_cpsv_compra
    ON customer_purchase_service (customer_purchase_id);
  CREATE INDEX IF NOT EXISTS ix_cpsv_servicio
    ON customer_purchase_service (service_id) WHERE consumed_at IS NULL;

  RAISE NOTICE '1.51.0 lista: customer_purchase_service reemplaza a customer_purchase_session';
END $$;

-- ── Verificación (correr aparte, no forma parte de la migración) ────────────
-- SELECT column_name, is_nullable FROM information_schema.columns
--  WHERE table_name = 'customer_purchase_service' ORDER BY ordinal_position;
