-- Fase 3 CRM: config no-secreta por canal + una fila por canal (upsert).
-- Idempotente. `encrypted_credentials` (secretos) queda para Fase 6.
ALTER TABLE channel_credentials
  ADD COLUMN IF NOT EXISTS config_json JSONB,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS channel_credentials_channel_type_key
  ON channel_credentials (channel_type);
