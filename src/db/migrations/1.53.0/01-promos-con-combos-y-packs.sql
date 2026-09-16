-- 1.53.0 — Promos con combos y packs
--
-- Una promo pasa a tener DOS listas:
--   · promotion_target  → qué está en oferta (ya existía desde 1.45.0, vacía)
--   · promotion_service → cuánto se le paga a cada proveedora (cambia de
--                         significado: antes eran "los servicios de la promo")
--
-- Un solo DO block: el SQL Editor de Supabase hace autocommit por sentencia.
DO $$
BEGIN
  -- El check que decide si la promo se publica en la web. Arranca destildado:
  -- publicar es una decisión, no un accidente. Hoy TODA promo activa se
  -- publica sola, porque PromosHero no filtra por nada.
  ALTER TABLE promotions ADD COLUMN IF NOT EXISTS is_visible_web boolean NOT NULL DEFAULT false;

  -- El total congelado de la promo no lo lee nadie, y con la lista de ofertas
  -- deja de tener sentido: el total depende de qué compre la clienta.
  ALTER TABLE promotions DROP COLUMN IF EXISTS services_subtotal;
  ALTER TABLE promotions DROP COLUMN IF EXISTS final_amount;

  -- El límite de usos pasa a contarse en vivo sobre las ventas no canceladas.
  -- Un contador se desincroniza y no sabe devolver el uso de una cancelación.
  ALTER TABLE promotions DROP COLUMN IF EXISTS times_used;

  -- El nombre de la promo, congelado en la venta: la compra cuenta su propia
  -- historia aunque la promo se edite o se borre.
  ALTER TABLE customer_purchase ADD COLUMN IF NOT EXISTS promotion_name varchar(255);

  -- Y por eso la promo ya puede borrarse sin arrastrar las ventas.
  ALTER TABLE customer_purchase DROP CONSTRAINT IF EXISTS customer_purchase_promotion_id_fkey;
  ALTER TABLE customer_purchase ADD CONSTRAINT customer_purchase_promotion_id_fkey
    FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE SET NULL;

  -- promotion_service pasa a ser "pagos acordados": el precio congelado sobra.
  ALTER TABLE promotion_service DROP COLUMN IF EXISTS service_price;

  -- Una fila de pago sin servicio, sin proveedora o sin monto no es un pago.
  -- La tabla está vacía en producción, así que exigirlo es seguro.
  ALTER TABLE promotion_service ALTER COLUMN service_id SET NOT NULL;
  ALTER TABLE promotion_service ALTER COLUMN service_provider_id SET NOT NULL;
  ALTER TABLE promotion_service ALTER COLUMN provider_payment SET NOT NULL;

  -- Un pago por (promo, servicio, proveedora). El acuerdo es con la proveedora
  -- por ese servicio, no por el combo: un servicio que está en dos combos de
  -- la misma promo lleva UN pago, no dos.
  ALTER TABLE promotion_service DROP CONSTRAINT IF EXISTS uq_promotion_service_pago;
  ALTER TABLE promotion_service ADD CONSTRAINT uq_promotion_service_pago
    UNIQUE (promotion_id, service_id, service_provider_id);

  RAISE NOTICE '1.53.0 aplicada';
END $$;

-- Verificación (correr aparte, NO dentro del DO):
-- select column_name from information_schema.columns
--  where table_name='promotions' and column_name in
--        ('is_visible_web','services_subtotal','final_amount','times_used');
-- Esperado: sólo is_visible_web.
