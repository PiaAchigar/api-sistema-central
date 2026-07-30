-- api-sistema-central/src/db/migrations/1.8.0/crm-pipeline.sql
-- ════════════════════════════════════════════════════════════════════════════
-- 1.8.0 — CRM Fase 1: pipeline de deals + crédito de cliente
-- ════════════════════════════════════════════════════════════════════════════
-- Agrega el pipeline de ventas (stage/assigned_agent_id/cancel_reason) a deals,
-- canales nuevos a contacts, y el saldo a favor del cliente (credit_balance) que
-- se acredita cuando se cancela un turno con seña ya paga (ver reglas_negocio §6.2).
-- Idempotente: se puede correr más de una vez sin romper.
--
-- Sobre la FK de `assigned_agent_id`: la columna YA EXISTE en el init.sql, donde
-- su foreign key hacia `users(id)` se llama `fk_deal_agent` (singular), NO
-- `fk_deals_assigned_agent`. Por eso el guard de abajo NO chequea por nombre
-- (chequear solo el nombre nuevo agregaría una SEGUNDA FK redundante sobre la
-- misma columna en toda base creada desde init.sql), sino si ya existe
-- CUALQUIER FK sobre esa columna. Así la migración es segura tal cual está,
-- tanto en una base nueva como en Supabase, sin pasos manuales.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS facebook_id VARCHAR(255);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS telegram_id VARCHAR(255);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_balance DECIMAL(10,2) NOT NULL DEFAULT 0;

ALTER TABLE deals ADD COLUMN IF NOT EXISTS stage VARCHAR(30) NOT NULL DEFAULT 'lead';
ALTER TABLE deals ADD COLUMN IF NOT EXISTS assigned_agent_id UUID NULL;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'deals'::regclass
      AND c.contype = 'f'
      AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
          WHERE attrelid = 'deals'::regclass AND attname = 'assigned_agent_id')
      ]::smallint[]
  ) THEN
    ALTER TABLE deals
      ADD CONSTRAINT fk_deals_assigned_agent
      FOREIGN KEY (assigned_agent_id) REFERENCES users(id);
  END IF;
END $$;

-- Backfill: todo deal existente (creado hoy solo vía registerDeposit al cobrar
-- una seña) ya tiene la seña paga, así que arranca en la etapa correspondiente.
UPDATE deals SET stage = 'senia_pagada' WHERE senia_paid = true AND stage = 'lead';
