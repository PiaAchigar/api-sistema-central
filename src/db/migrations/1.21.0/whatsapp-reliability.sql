-- 1.21.0: WhatsApp Reliability — Reintentos, Queue, Logs, Rate Limiting

-- ============================================================================
-- TABLE: message_queue
-- ============================================================================
-- Para guardar mensajes pendientes de ser enviados (automatizaciones). El
-- worker background procesa esta cola cada 10 segundos, respetando rate limit.

CREATE TABLE IF NOT EXISTS message_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('agent', 'system')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  retry_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  external_message_id VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP,
  scheduled_for TIMESTAMP,

  CONSTRAINT fk_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_message_queue_status ON message_queue(status) WHERE status = 'pending';
CREATE INDEX idx_message_queue_scheduled ON message_queue(scheduled_for) WHERE status = 'pending' AND scheduled_for IS NOT NULL;
CREATE INDEX idx_message_queue_created ON message_queue(created_at DESC);

-- ============================================================================
-- TABLE: delivery_logs
-- ============================================================================
-- Auditoria de intentos de envío (exitosos y fallidos). Se limpia semanalmente.
-- Sirve para investigar fallos recientes y rastrear qué mensajes se entregaron.

CREATE TABLE IF NOT EXISTS delivery_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
  status VARCHAR(20) NOT NULL CHECK (status IN ('success', 'failed', 'retry')),
  meta_error_code INT,
  meta_error_message TEXT,
  retry_attempt INT NOT NULL DEFAULT 1,
  http_status_code INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_conversation_log FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_delivery_logs_status ON delivery_logs(status);
CREATE INDEX idx_delivery_logs_created ON delivery_logs(created_at DESC);
CREATE INDEX idx_delivery_logs_conversation ON delivery_logs(conversation_id);
CREATE INDEX idx_delivery_logs_contact ON delivery_logs(contact_id);

-- ============================================================================
-- TABLE: rate_limit_buckets
-- ============================================================================
-- Contador de mensajes por usuario por minuto. Se reseta cada minuto.
-- Para rate limiting manual (50/min) y automatizaciones (10/min) en Postgres.

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  user_id UUID NOT NULL,
  minute_key VARCHAR(50) NOT NULL,
  count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),

  PRIMARY KEY (user_id, minute_key),
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_rate_limit_buckets_created ON rate_limit_buckets(created_at);

-- ============================================================================
-- Auto-cleanup: columna de tracking para logs antiguos
-- ============================================================================
-- Con pg_cron en Supabase, ejecutar cada lunes 02:00 UTC:
--   DELETE FROM delivery_logs WHERE created_at < NOW() - INTERVAL '1 week';
--   DELETE FROM message_queue WHERE created_at < NOW() - INTERVAL '1 week'
--     AND status IN ('sent', 'failed', 'cancelled');

-- En local (sin pg_cron), el frontend detecta expiración y muestra modal de aviso.
