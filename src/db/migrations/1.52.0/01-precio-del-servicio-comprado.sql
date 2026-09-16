-- 1.52.0 — El precio de cada servicio comprado, congelado al vender.
--
-- POR QUÉ
-- Al cancelar una compra, el saldo a favor se repartía por CANTIDAD de
-- servicios. Eso sólo es correcto cuando todos valen lo mismo. En el
-- "Combo1-prueba" de producción no: Baby Botox $249.000 contra una depilación
-- facial de $17.500. Cancelarlo con el Botox hecho le acreditaba a la clienta
-- la mitad —$106.600— por un servicio de $17.500. Laura regalaba $92.000 por
-- cancelación, siempre para el mismo lado (Pia, 2026-09-16).
--
-- Con el precio guardado por fila, la cuenta pasa a pesar cada servicio por lo
-- que vale. Un pack del mismo servicio sigue dando lo mismo que antes, porque
-- ahí todas las partes valen igual: es una sola regla, no dos.
--
-- POR QUÉ CONGELADO Y NO LEÍDO DEL COMBO
-- La venta ya congela `base_amount` y `final_amount` por el mismo motivo: si
-- mañana se edita o se archiva el combo, la cuenta de una compra vieja no
-- puede cambiar sola ni quedarse sin datos.
--
-- NULL = la compra no se desglosa en servicios con precio propio (un pack de
-- depilación, una capacitación). Ahí todas las filas valen lo mismo y el
-- reparto en partes iguales es el correcto.
--
-- Un solo bloque DO: el editor SQL de Supabase hace autocommit por sentencia.

DO $$
DECLARE
  filas integer;
BEGIN
  ALTER TABLE customer_purchase_service
    ADD COLUMN IF NOT EXISTS price numeric(10,2);

  -- El pasado: las compras de combo pueden recuperar el precio del renglón
  -- con el que se armó el combo, que es exactamente el que se usó para
  -- cotizarlas. Las demás quedan en NULL y caen al reparto en partes iguales.
  UPDATE customer_purchase_service cps
     SET price = cs.service_price
    FROM customer_purchase cp
    JOIN combo_service cs ON cs.combo_id = cp.combo_id
   WHERE cps.customer_purchase_id = cp.id
     AND cps.service_id = cs.service_id
     AND cps.price IS NULL;

  GET DIAGNOSTICS filas = ROW_COUNT;
  RAISE NOTICE 'Precio rellenado en % servicios comprados de combos.', filas;

  SELECT count(*) INTO filas FROM customer_purchase_service WHERE price IS NULL;
  RAISE NOTICE '% servicios comprados quedan sin precio (reparto en partes iguales).', filas;
END $$;

-- Verificación, para correr aparte:
--
-- select cp.description, s.name, cps.price
--   from customer_purchase_service cps
--   join customer_purchase cp on cp.id = cps.customer_purchase_id
--   left join service s on s.id = cps.service_id
--  order by cp.created_at desc, cps.repeticion, cps.orden;
