-- api-sistema-central/src/db/migrations/1.8.0/crm-pipeline.sql
-- ════════════════════════════════════════════════════════════════════════════
-- 1.8.0 — CRM Fase 1: pipeline de deals + crédito de cliente
-- ════════════════════════════════════════════════════════════════════════════
-- Agrega el pipeline de ventas (stage/assigned_agent_id/cancel_reason) a deals,
-- canales nuevos a contacts, y el saldo a favor del cliente (credit_balance) que
-- se acredita cuando se cancela un turno con seña ya paga (ver reglas_negocio §6.2).
-- Idempotente: se puede correr más de una vez sin romper.
--
-- ⚠️  ANTES DE APLICAR ESTO EN SUPABASE (PRODUCCIÓN), LEER ESTO ⚠️
-- ────────────────────────────────────────────────────────────────────────────
-- `deals.assigned_agent_id` YA EXISTE en el init.sql de producción, y allá la
-- foreign key hacia `users(id)` se llama `fk_deal_agent` (singular), NO
-- `fk_deals_assigned_agent`. El bloque DO de más abajo solo chequea el nombre
-- NUEVO, así que si se corre tal cual en Supabase va a agregar una SEGUNDA FK
-- REDUNDANTE sobre la misma columna.
--
-- Antes de correr esta migración en producción, verificar:
--
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'deals'::regclass AND contype = 'f';
--
-- Si aparece `fk_deal_agent` (o cualquier otra FK sobre `assigned_agent_id`),
-- SALTEAR / COMENTAR el bloque DO $$ ... END $$ de la FK — el resto de la
-- migración sí se aplica normalmente.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS facebook_id VARCHAR(255);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS telegram_id VARCHAR(255);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_balance DECIMAL(10,2) NOT NULL DEFAULT 0;

ALTER TABLE deals ADD COLUMN IF NOT EXISTS stage VARCHAR(30) NOT NULL DEFAULT 'lead';
ALTER TABLE deals ADD COLUMN IF NOT EXISTS assigned_agent_id UUID NULL;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_deals_assigned_agent'
  ) THEN
    ALTER TABLE deals
      ADD CONSTRAINT fk_deals_assigned_agent
      FOREIGN KEY (assigned_agent_id) REFERENCES users(id);
  END IF;
END $$;

-- Backfill: todo deal existente (creado hoy solo vía registerDeposit al cobrar
-- una seña) ya tiene la seña paga, así que arranca en la etapa correspondiente.
UPDATE deals SET stage = 'senia_pagada' WHERE senia_paid = true AND stage = 'lead';
