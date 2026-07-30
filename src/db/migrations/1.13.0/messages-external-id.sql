ALTER TABLE messages ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS messages_external_id_key ON messages (external_id) WHERE external_id IS NOT NULL;
