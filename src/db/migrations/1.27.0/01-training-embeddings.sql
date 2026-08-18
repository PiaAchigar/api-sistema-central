-- ════════════════════════════════════════════════════════════════════════════
-- 1.27.0 / 01 — Embeddings de capacitaciones
-- ════════════════════════════════════════════════════════════════════════════
-- Tercera y última pata del buscador "¿Cuál es tu objetivo?": ya existen
-- service_embeddings (1.4.0) y activity_embeddings (1.26.0/06). Sin esta, las 6
-- capacitaciones nunca aparecen como respuesta.
--
-- Igual que sus dos hermanas: el trigger mantiene el TEXTO, y el VECTOR lo
-- calcula aparte el worker embedding-calculator con la API de OpenAI.
--
-- Idempotente: se puede correr más de una vez.

CREATE TABLE IF NOT EXISTS training_embeddings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  training_id UUID NOT NULL UNIQUE,
  content     TEXT NOT NULL,
  embedding   vector(1536),
  updated_at  TIMESTAMP NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_training_embeddings_training') THEN
    ALTER TABLE training_embeddings
      ADD CONSTRAINT fk_training_embeddings_training
      FOREIGN KEY (training_id) REFERENCES training(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_training_embeddings_training_id
  ON training_embeddings(training_id);
CREATE INDEX IF NOT EXISTS idx_training_embeddings_embedding
  ON training_embeddings USING ivfflat (embedding vector_cosine_ops);

-- El `content` de una capacitación suma más campos que el de un servicio porque
-- son lo que una clienta pregunta: modalidad (presencial/online), si certifica y
-- qué requiere saber de antes.
CREATE OR REPLACE FUNCTION trg_training_embeddings_sync_fn()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO training_embeddings (training_id, content, embedding, updated_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.name,'') || '. ' ||
    COALESCE(NEW.description,'') || ' ' ||
    COALESCE(NEW.prerequisites_text,'') || ' ' ||
    COALESCE(NEW.certification_title,''),
    NULL,
    now())
  ON CONFLICT (training_id) DO UPDATE
    SET content = EXCLUDED.content,
        -- Si cambió el texto el vector viejo ya no lo representa: se invalida y
        -- el embedding-calculator lo vuelve a calcular en su próxima corrida.
        embedding = NULL,
        updated_at = now()
   WHERE training_embeddings.content IS DISTINCT FROM EXCLUDED.content;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_training_embeddings_sync ON training;
CREATE TRIGGER trg_training_embeddings_sync
  AFTER INSERT OR UPDATE ON training
  FOR EACH ROW EXECUTE FUNCTION trg_training_embeddings_sync_fn();

-- Sembrar las 6 que ya existen: el trigger solo cubre las futuras.
INSERT INTO training_embeddings (training_id, content, embedding, updated_at)
SELECT t.id,
       COALESCE(t.name,'') || '. ' || COALESCE(t.description,'') || ' ' ||
       COALESCE(t.prerequisites_text,'') || ' ' || COALESCE(t.certification_title,''),
       NULL, now()
  FROM training t
ON CONFLICT (training_id) DO NOTHING;
