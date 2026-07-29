-- Fase 4 CRM: un hilo por (contacto, canal). Habilita el upsert al crear/escribir.
-- La tabla conversations está vacía en prod, así que el índice único no choca.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_contact_channel_key
  ON conversations (contact_id, channel);
