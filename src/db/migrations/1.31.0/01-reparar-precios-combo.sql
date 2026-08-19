-- ═══════════════════════════════════════════════════════════════════════════
-- 1.31.0 — Reparar los precios congelados de las líneas de combo
--
-- POR QUÉ EXISTE: `combo_service.service_price` se congelaba leyendo sólo
-- `service.unit_price_list`. En producción **79 de 213 servicios activos no
-- tienen precio de lista** —sólo `unit_price_cash`—, así que cualquier combo
-- armado con esos servicios quedaba congelado en $0, y el combo entero valía
-- $0 sin importar cuántas sesiones o qué descuento tuviera.
--
-- Pasó de verdad: el primer combo cargado en producción ("Depi 1 - Prueba",
-- 4 sesiones de Axila con 10% de descuento) mostraba $0.
--
-- El código ya está corregido (ver `precioDeServicio()` en
-- `src/lib/combo-pricing.ts`). Esta migración arregla las filas que quedaron
-- mal ANTES de esa corrección.
--
-- Es segura de correr más de una vez: sólo toca las filas que quedaron en 0 o
-- en NULL, así que no pisa ningún precio que ya esté bien.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE combo_service cs
SET service_price = COALESCE(s.unit_price_list, s.unit_price_cash, 0)
FROM service s
WHERE s.id = cs.service_id
  AND (cs.service_price IS NULL OR cs.service_price = 0)
  AND COALESCE(s.unit_price_list, s.unit_price_cash) IS NOT NULL;

-- ── Verificación ───────────────────────────────────────────────────────────
-- Después de correrla no debería quedar ninguna línea en $0 cuyo servicio sí
-- tenga algún precio cargado:
--
-- SELECT cs.id, s.name, cs.service_price, s.unit_price_list, s.unit_price_cash
-- FROM combo_service cs
-- JOIN service s ON s.id = cs.service_id
-- WHERE (cs.service_price IS NULL OR cs.service_price = 0)
--   AND COALESCE(s.unit_price_list, s.unit_price_cash) IS NOT NULL;
