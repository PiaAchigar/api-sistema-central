-- ════════════════════════════════════════════════════════════════════════════
-- 1.22.2 — Elimina el FK colgado de TRAINING_SUBSCRIPTIONS hacia TRAINING
-- ════════════════════════════════════════════════════════════════════════════
-- La migración 1.20.0 creó la columna inline:
--     training_id UUID NOT NULL REFERENCES training(id) ON DELETE RESTRICT
-- Postgres autonombró ese constraint `training_subscriptions_training_id_fkey`.
--
-- La 1.21.2 intentó eliminarlo con
--     DROP CONSTRAINT IF EXISTS fk_training_subscriptions_training_id
-- — un nombre que nunca existió. Con IF EXISTS, el DROP fue un no-op silencioso.
--
-- Resultado: después de renombrar training_id → activity_id, la columna quedó
-- con DOS foreign keys apuntando a tablas distintas:
--     fk_training_subscriptions_activity_id  → activities(id)   ✅ correcto
--     training_subscriptions_training_id_fkey → training(id)    ❌ colgado
--
-- Cualquier INSERT de una suscripción a una ACTIVIDAD falla, porque ese
-- activity_id no existe en TRAINING. Es decir, POST /api/training-subscriptions
-- está roto de raíz mientras este constraint siga vivo.

ALTER TABLE training_subscriptions
  DROP CONSTRAINT IF EXISTS training_subscriptions_training_id_fkey;
