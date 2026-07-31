CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_id
  ON messages (conversation_id, created_at, id);
