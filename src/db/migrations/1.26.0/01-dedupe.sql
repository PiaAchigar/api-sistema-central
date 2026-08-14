-- ════════════════════════════════════════════════════════════════════════════
-- 1.26.0 / 01 — Sacar duplicaciones: 13 actividades y el Pilates repetido
-- ════════════════════════════════════════════════════════════════════════════
-- (A) Las 13 actividades vivían dos veces: en `activities` (fuente de verdad,
--     la usan training_subscriptions y activity_attendance) y como filas de
--     `service` con nombre idéntico. Se van de `service`.
--     Verificado: 0 referencias en line_items, appointments, promotion_service,
--     service_machine y service_provider_service. service_embeddings es CASCADE.
--
-- (B) Había DOS categorías "Pilates": una raíz (738179c0) con los 8 servicios
--     sueltos, y otra bajo General (c5f0c82d) con las dos hijas reales. Sobrevive
--     la de General, que es la que tiene la jerarquía.
--
-- NO es idempotente por diseño: borra filas concretas. Correr UNA vez.

-- (A) — guardar qué se borra, después borrar
CREATE TABLE IF NOT EXISTS service_borrados_1260 AS
SELECT s.*, now() AS deleted_at
  FROM service s
 WHERE s.id IN (
   SELECT DISTINCT sc.service_id FROM service_category sc
    WHERE sc.category_id IN ('738179c0-38e4-433d-8e11-70c5cd7a1fef',
                             '3ab0772b-5a9d-4690-9936-06b730717ba0',
                             '5d83be2e-4d29-498d-ae9c-42bae13d6435',
                             '8ab6b67f-f92a-4b3c-8505-d66c630fda71'));

DELETE FROM service_category
 WHERE service_id IN (SELECT id FROM service_borrados_1260);

DELETE FROM service
 WHERE id IN (SELECT id FROM service_borrados_1260);

-- (B) — la categoría Pilates duplicada queda archivada, nunca borrada (regla 1.3)
UPDATE categories
   SET is_active = false,
       description = COALESCE(description || ' | ', '') ||
                     'Archivada en 1.26.0: duplicaba a General > Pilates (c5f0c82d).'
 WHERE id = '738179c0-38e4-433d-8e11-70c5cd7a1fef';
