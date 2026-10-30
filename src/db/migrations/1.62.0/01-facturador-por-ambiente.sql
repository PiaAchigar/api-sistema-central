-- 1.62.0 — un mismo CUIT y punto de venta en los dos ambientes
--
-- El índice uq_arca_issuers_cuit_pos era (cuit, point_of_sale, invoice_type) y
-- dejaba afuera `environment`. Con eso, un CUIT no podía tener el MISMO punto
-- de venta en homologación y en producción: la segunda fila chocaba con un
-- unique violation. Obligaba a probar con un punto de venta distinto del real,
-- que es justo lo que no querés de un ambiente de prueba — el punto de venta
-- es parte de lo que se está probando (ARCA rechaza si no es de tipo Web
-- Services, y el QR del PDF lo lleva adentro).
--
-- Agregar una columna a un índice único sólo AFLOJA la restricción, nunca la
-- endurece, así que esto no puede fallar contra datos existentes.
--
-- Idempotente: se puede correr más de una vez.

BEGIN;

-- El índice viejo lo crea 1.9.0/arca-issuers.sql, que en un volumen nuevo corre
-- antes que esta migración. Por eso se dropea acá en vez de editar aquel
-- archivo: así una base recién creada y una ya existente terminan igual.
DROP INDEX IF EXISTS uq_arca_issuers_cuit_pos;

CREATE UNIQUE INDEX IF NOT EXISTS uq_arca_issuers_cuit_pos_env
  ON arca_issuers (cuit, point_of_sale, invoice_type, environment);

COMMIT;

-- Verificación (no falla la migración, sólo deja constancia en el log):
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'arca_issuers' AND indexname = 'uq_arca_issuers_cuit_pos_env';
  IF n = 1 THEN
    RAISE NOTICE '1.62.0 OK: uq_arca_issuers_cuit_pos_env creado';
  ELSE
    RAISE WARNING '1.62.0: no se encontró uq_arca_issuers_cuit_pos_env';
  END IF;
END $$;
