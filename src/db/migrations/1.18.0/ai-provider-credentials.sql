-- ════════════════════════════════════════════════════════════════════════════
-- 1.18.0 — Credenciales de proveedores de IA (OpenAI, Deepseek, etc)
-- ════════════════════════════════════════════════════════════════════════════
-- Tabla para guardar API keys encriptadas de proveedores de IA usados en:
--   · Generación de embeddings para búsqueda semántica
--   · RAG / chatbot
--   · Automatizaciones
--
-- Una sola credencial activa por proveedor (índice único)

CREATE TABLE IF NOT EXISTS ai_provider_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(50) NOT NULL,
  api_key TEXT NOT NULL,
  model VARCHAR(100),
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índice único: solo una credencial activa por proveedor
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_credentials_active
  ON ai_provider_credentials (provider)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_ai_provider_credentials_provider
  ON ai_provider_credentials (provider);
