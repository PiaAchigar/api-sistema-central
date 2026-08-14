-- ════════════════════════════════════════════════════════════════════════════
-- 1.26.0 / 06 — Embeddings de actividades (para el buscador por objetivo)
-- ════════════════════════════════════════════════════════════════════════════
-- Espeja service_embeddings (1.4.0). Las actividades salieron de `service` en
-- la 1.26.0/01, así que sin esta tabla dejarían de aparecer en el buscador
-- "¿Cuál es tu objetivo?" de la web.
--
-- Idempotente: se puede correr múltiples veces sin romper (IF NOT EXISTS /
-- OR REPLACE / DO $$ guard en el constraint). Requiere la extensión pgvector
-- habilitada (Supabase: Database → Extensions → "vector"; en local ya está).

CREATE TABLE IF NOT EXISTS activity_embeddings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id UUID NOT NULL UNIQUE,
  content     TEXT NOT NULL,
  embedding   vector(1536),
  updated_at  TIMESTAMP NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_activity_embeddings_activity') THEN
    ALTER TABLE activity_embeddings
      ADD CONSTRAINT fk_activity_embeddings_activity
      FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_activity_embeddings_activity_id
  ON activity_embeddings(activity_id);
CREATE INDEX IF NOT EXISTS idx_activity_embeddings_embedding
  ON activity_embeddings USING ivfflat (embedding vector_cosine_ops);

-- El content se arma con lo que describe la actividad. Igual que en services,
-- el VECTOR se calcula aparte en la API: acá solo se mantiene el texto.
CREATE OR REPLACE FUNCTION trg_activity_embeddings_sync_fn()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO activity_embeddings (activity_id, content, embedding, updated_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.name,'') || '. ' || COALESCE(NEW.description,''),
    NULL,
    now())
  ON CONFLICT (activity_id) DO UPDATE
    SET content = EXCLUDED.content,
        -- Si cambió el texto, el vector viejo ya no lo representa: se invalida
        -- y el embedding-calculator lo vuelve a calcular.
        embedding = NULL,
        updated_at = now()
   WHERE activity_embeddings.content IS DISTINCT FROM EXCLUDED.content;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_activity_embeddings_sync ON activities;
CREATE TRIGGER trg_activity_embeddings_sync
  AFTER INSERT OR UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION trg_activity_embeddings_sync_fn();

-- Sembrar las 13 actividades que ya existen (el trigger solo cubre las futuras)
INSERT INTO activity_embeddings (activity_id, content, embedding, updated_at)
SELECT a.id, COALESCE(a.name,'') || '. ' || COALESCE(a.description,''), NULL, now()
  FROM activities a
ON CONFLICT (activity_id) DO NOTHING;
