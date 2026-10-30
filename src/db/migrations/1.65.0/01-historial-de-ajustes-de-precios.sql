-- ════════════════════════════════════════════════════════════════════════════
-- 1.65.0 / 01 — Historial del ajuste de precios en bloque (#34)
-- ════════════════════════════════════════════════════════════════════════════
-- Cada vez que Laura aplica un ajuste de precios a una rama de categorías queda
-- una fila en `price_adjustments` (qué pidió y quién) y una por servicio en
-- `price_adjustment_items` (precios antes/después). Sirve para auditar y para
-- deshacer a mano si hace falta.
--
-- `category_id` va SIN FK: la categoría puede borrarse y el historial queda.
-- Cuatro sentencias sueltas (SQL Editor de Supabase: autocommit por sentencia), idempotentes.
-- RLS activado como en el resto de las tablas de `public`: sin esto la clave publishable
-- podría leer y reescribir el historial por la Data API. El Worker entra como dueño
-- (postgres) y no se ve afectado.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS price_adjustments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  user_id        text,
  user_email     text,
  category_id    uuid,
  direction      varchar(10) NOT NULL,
  mode           varchar(12) NOT NULL,
  value          numeric(12,2) NOT NULL,
  rounding       int NOT NULL,
  services_count int NOT NULL
);

CREATE TABLE IF NOT EXISTS price_adjustment_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_id uuid NOT NULL REFERENCES price_adjustments(id) ON DELETE CASCADE,
  service_id    uuid NOT NULL,
  list_before   numeric(10,2),
  list_after    numeric(10,2),
  cash_before   numeric(10,2),
  cash_after    numeric(10,2)
);
ALTER TABLE price_adjustments ENABLE ROW LEVEL SECURITY;

ALTER TABLE price_adjustment_items ENABLE ROW LEVEL SECURITY;

-- Verificación (correr aparte):
-- SELECT a.created_at, a.user_email, a.direction, a.mode, a.value, a.services_count FROM price_adjustments a ORDER BY 1 DESC;
