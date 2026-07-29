-- Fase 5a CRM: reglas de automatización determinísticas + registro de ejecuciones.
-- Idempotente.
CREATE TABLE IF NOT EXISTS automation_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  trigger_type  VARCHAR(50) NOT NULL,
  conditions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_type   VARCHAR(50) NOT NULL,
  action_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMP DEFAULT now(),
  updated_at    TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         UUID,
  trigger_type    VARCHAR(50),
  contact_id      UUID,
  conversation_id UUID,
  deal_id         UUID,
  status          VARCHAR(50),
  detail          TEXT,
  created_at      TIMESTAMP DEFAULT now()
);
