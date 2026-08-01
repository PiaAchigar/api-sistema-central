-- ════════════════════════════════════════════════════════════════════════════
-- 1.16.0 — Detalle y cliente de cada cobro (rendición de caja)
-- ════════════════════════════════════════════════════════════════════════════
-- Una cobranza mixta (parte facturada a ARCA, parte no) genera DOS pagos: el
-- declarado, colgado de la factura, y el no declarado, suelto. Hasta ahora ese
-- segundo pago era ciego en la rendición de caja:
--
--   · sin cliente  → el nombre se sacaba del JOIN con la factura, y este pago
--     no tiene factura. Se listaba como "Cobro", sin saber de quién era.
--   · sin detalle  → los ítems NO facturables no se guardaban en ningún lado
--     (solo existían en el request del checkout), así que era imposible saber
--     qué servicios se habían cobrado.
--
-- Con estas dos columnas cada cobro queda identificado:
--   · payments.customer_id   → de quién es el cobro, haya factura o no.
--   · line_items.payment_id  → qué se cobró en ese pago. Las líneas facturadas
--     quedan con invoice_id Y payment_id; las no facturadas, solo con payment_id
--     (son un recibo, no un comprobante fiscal).
--
-- Ambas nullable: los pagos anteriores siguen resolviéndose por la factura.
-- Idempotente: se puede correr más de una vez sin romper.

ALTER TABLE payments    ADD COLUMN IF NOT EXISTS customer_id UUID NULL;
ALTER TABLE line_items  ADD COLUMN IF NOT EXISTS payment_id  UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'payments'::regclass AND c.contype = 'f'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
        WHERE attrelid = 'payments'::regclass AND attname = 'customer_id')]::smallint[]
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT fk_payments_customer FOREIGN KEY (customer_id) REFERENCES customers(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'line_items'::regclass AND c.contype = 'f'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
        WHERE attrelid = 'line_items'::regclass AND attname = 'payment_id')]::smallint[]
  ) THEN
    ALTER TABLE line_items
      ADD CONSTRAINT fk_line_items_payment FOREIGN KEY (payment_id) REFERENCES payments(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payments_customer   ON payments (customer_id);
CREATE INDEX IF NOT EXISTS idx_line_items_payment  ON line_items (payment_id);

-- Backfill: los pagos que ya tienen factura (o turno) heredan su cliente, así la
-- rendición vieja también queda agrupada por cliente. Los cobros sueltos no
-- declarados anteriores a esta migración no tienen de dónde deducirlo y quedan
-- sin cliente: esa información nunca se guardó.
UPDATE payments p
   SET customer_id = i.customer_id
  FROM invoices i
 WHERE p.invoice_id = i.id
   AND p.customer_id IS NULL
   AND i.customer_id IS NOT NULL;

UPDATE payments p
   SET customer_id = a.customer_id
  FROM appointments a
 WHERE p.appointment_id = a.id
   AND p.customer_id IS NULL
   AND a.customer_id IS NOT NULL;
