-- ════════════════════════════════════════════════════════════════════════════
-- 1.17.0 — Embeddings vectoriales para búsqueda semántica de tratamientos
-- ════════════════════════════════════════════════════════════════════════════
-- Tabla para almacenar embeddings de servicios (1536 dimensiones con OpenAI/Deepseek).
-- Se usa para búsqueda híbrida: embeddings semánticos + promociones relacionadas.

-- Habilitar extensión pgvector si no existe
CREATE EXTENSION IF NOT EXISTS vector;

-- Crear tabla de embeddings
CREATE TABLE IF NOT EXISTS service_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL UNIQUE REFERENCES service(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  embedding_model VARCHAR(50) DEFAULT 'deepseek',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índice IVFFlat para búsqueda rápida por similitud vectorial
-- (usa distancia coseno por defecto con pgvector)
CREATE INDEX IF NOT EXISTS idx_service_embeddings_vector
  ON service_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_service_embeddings_service
  ON service_embeddings (service_id);
