-- ════════════════════════════════════════════════════════════════════════════
-- 1.4.0 — Infraestructura RAG: embeddings semánticos + chatbot inteligente
-- ════════════════════════════════════════════════════════════════════════════
-- Agrega campos de contenido RAG a `service` (benefits, contraindications,
-- special_attention_notes), crea tabla `service_embeddings` con vectores
-- pgvector(1536), tabla `ai_provider_credentials` para Laura, y trigger
-- automático que actualiza embeddings cuando cambia un servicio.
--
-- Idempotente: se puede correr múltiples veces sin romper. Requiere pgvector
-- extension habilitada en Supabase (no en Docker local).
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Extensión pgvector — SOLO SUPABASE
-- ────────────────────────────────────────────────────────────────────────────
-- En local (Docker): pgvector no está disponible. El trigger y las búsquedas
-- semánticas funcionarán en Supabase solamente.
--
-- En Supabase: ir a Database → Extensions → habilitar "vector"
-- ────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Agregar campos de contenido RAG a la tabla SERVICE
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE service ADD COLUMN IF NOT EXISTS benefits TEXT;
ALTER TABLE service ADD COLUMN IF NOT EXISTS contraindications TEXT;
ALTER TABLE service ADD COLUMN IF NOT EXISTS special_attention_notes TEXT;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Tabla SERVICE_EMBEDDINGS — Almacena vectores (embeddings) por servicio
-- ────────────────────────────────────────────────────────────────────────────
-- Cada fila corresponde a UN servicio y almacena:
--   - service_id: referencia al servicio (1:1)
--   - content: texto concatenado (descripción + benefits + contraindications)
--   - embedding: vector 1536-dim (Claude 3.5 Sonnet embedding model)
--   - updated_at: timestamp de última actualización del vector
--
-- El trigger `trg_service_embeddings_sync` actualiza `content` automáticamente
-- cuando el servicio cambia. El embedding (vector) se calcula en la API.
CREATE TABLE IF NOT EXISTS service_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL UNIQUE REFERENCES service(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector(1536),
  updated_at TIMESTAMP DEFAULT now(),

  CONSTRAINT fk_service_embeddings_service FOREIGN KEY (service_id)
    REFERENCES service(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_service_embeddings_service_id ON service_embeddings(service_id);
CREATE INDEX IF NOT EXISTS idx_service_embeddings_embedding
  ON service_embeddings USING ivfflat (embedding vector_cosine_ops);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Tabla AI_PROVIDER_CREDENTIALS — Credenciales de proveedores de IA
-- ────────────────────────────────────────────────────────────────────────────
-- Almacena claves de API de Laura para varios proveedores (Claude, etc).
-- Solo se usa UNA credencial por proveedor (la que tenga is_active=true).
CREATE TABLE IF NOT EXISTS ai_provider_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(50) NOT NULL,
  api_key TEXT NOT NULL,
  model VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Índice único: solo UNA credencial activa por proveedor
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_active
  ON ai_provider_credentials(provider)
  WHERE is_active = true;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Trigger: Actualizar `content` en SERVICE_EMBEDDINGS cuando SERVICE cambia
-- ────────────────────────────────────────────────────────────────────────────
-- La función `trg_service_embeddings_sync_fn` concatena:
--   - description (de service)
--   - benefits
--   - contraindications
--   - special_attention_notes
--
-- Cada vez que se ACTUALIZA un service, se crea o actualiza automáticamente
-- la fila en service_embeddings con el nuevo `content`.
-- Nota: el campo `embedding` (vector) se calcula por separado en la API.

CREATE OR REPLACE FUNCTION trg_service_embeddings_sync_fn()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO service_embeddings (service_id, content, updated_at)
  VALUES (
    NEW.id,
    CONCAT_WS(
      ' | ',
      NEW.name,
      NEW.description,
      NEW.benefits,
      NEW.contraindications,
      NEW.special_attention_notes
    ),
    now()
  )
  ON CONFLICT (service_id)
  DO UPDATE SET
    content = CONCAT_WS(
      ' | ',
      NEW.name,
      NEW.description,
      NEW.benefits,
      NEW.contraindications,
      NEW.special_attention_notes
    ),
    updated_at = now();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- El trigger se ejecuta después de INSERT o UPDATE en SERVICE
CREATE TRIGGER trg_service_embeddings_sync
AFTER INSERT OR UPDATE ON service
FOR EACH ROW
EXECUTE FUNCTION trg_service_embeddings_sync_fn();

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Backfill: Crear entries en SERVICE_EMBEDDINGS para servicios existentes
-- ────────────────────────────────────────────────────────────────────────────
-- Si ya hay servicios en la BD (e.g., seed data), asegurarse que tengan
-- entrada en service_embeddings.
INSERT INTO service_embeddings (service_id, content, updated_at)
SELECT
  s.id,
  CONCAT_WS(
    ' | ',
    s.name,
    s.description,
    s.benefits,
    s.contraindications,
    s.special_attention_notes
  ),
  now()
FROM service s
WHERE NOT EXISTS (
  SELECT 1 FROM service_embeddings se WHERE se.service_id = s.id
)
ON CONFLICT (service_id) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Verificación post-migración (comentada, descomenta para testing)
-- ────────────────────────────────────────────────────────────────────────────
/*
-- Verificar que extensión pgvector existe
SELECT extname FROM pg_extension WHERE extname = 'vector';

-- Verificar campos nuevos en SERVICE
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'service'
  AND column_name IN ('benefits', 'contraindications', 'special_attention_notes')
ORDER BY column_name;

-- Verificar tablas nuevas
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('service_embeddings', 'ai_provider_credentials');

-- Verificar índices
SELECT indexname FROM pg_indexes
WHERE tablename IN ('service_embeddings', 'ai_provider_credentials')
ORDER BY indexname;

-- Verificar trigger
SELECT trigger_name FROM information_schema.triggers
WHERE event_object_table = 'service'
  AND trigger_name = 'trg_service_embeddings_sync';

-- Contar filas en service_embeddings (debe ser = al total de services)
SELECT COUNT(*) as total_embeddings FROM service_embeddings;
SELECT COUNT(*) as total_services FROM service;
*/
