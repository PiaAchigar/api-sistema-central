-- 1.68.0 — Lo que Laura controla de Depilación y de las categorías en la web.
--
-- body_zone.is_visible_web: si la zona se publica en la web. Arranca en true
-- para que nada desaparezca al aplicar esto. Ocultar una zona NO la saca del
-- CRM: se puede seguir vendiendo.
--
-- categories.web_description: el texto que va debajo del título de la categoría
-- en /servicios. Es una columna aparte de `description` a propósito: esa ya
-- tiene notas internas ("Capacitaciones y workshops (tabla TRAINING)") que no
-- deben salir a la web.
--
-- Una sola sentencia para que sobreviva al SQL Editor de Supabase, y se puede
-- correr dos veces sin efecto.
--
-- ⚠️ Aplicar ANTES de desplegar la API: el Worker nuevo lee estas dos columnas
-- y sin ellas fallan el catálogo de categorías y las zonas.
DO $$
BEGIN
  ALTER TABLE body_zone
    ADD COLUMN IF NOT EXISTS is_visible_web boolean NOT NULL DEFAULT true;
  ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS web_description text;
END $$;
