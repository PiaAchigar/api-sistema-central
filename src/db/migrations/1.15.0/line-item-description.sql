-- ════════════════════════════════════════════════════════════════════════════
-- 1.15.0 — Detalle propio por línea de factura
-- ════════════════════════════════════════════════════════════════════════════
-- Hasta ahora el texto de cada ítem se derivaba del JOIN con service/product,
-- así que una seña se veía igual que el servicio completo ("Lifting de Pestañas")
-- tanto en la pantalla como en el PDF que recibe el cliente.
--
-- Con `description` cada línea puede llevar su propio concepto — la seña guarda
-- "Seña de servicio: <nombre>". Es opcional: si viene NULL se sigue mostrando el
-- nombre del servicio o producto, así las facturas anteriores no cambian.
--
-- Idempotente: se puede correr más de una vez sin romper.

ALTER TABLE line_items ADD COLUMN IF NOT EXISTS description VARCHAR(255);
