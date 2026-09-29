-- 1.57.0 — El vector de un servicio se invalida cuando cambia su texto
--
-- PROBLEMA
-- `trg_service_embeddings_sync_fn` actualizaba el `content` de
-- `service_embeddings` pero NUNCA tocaba `embedding`. Y el calculador
-- (`src/workers/embedding-calculator.ts`) sólo procesa las filas
-- `WHERE embedding IS NULL`. Resultado: editar el nombre o la descripción de
-- un servicio cambia el texto y deja el vector viejo **para siempre**. El
-- buscador de la web sigue respondiendo contra el texto anterior y se va
-- separando del catálogo en silencio, sin error que lo delate.
--
-- Las funciones hermanas de actividades y capacitaciones YA hacen lo correcto
-- (invalidan el vector cuando el texto cambia). A la de servicios nunca se le
-- aplicó ese arreglo; verificado contra producción el 2026-09-29:
--   trg_activity_embeddings_sync_fn -> invalida
--   trg_training_embeddings_sync_fn -> invalida
--   trg_service_embeddings_sync_fn  -> NO invalida
--
-- QUÉ CAMBIA
-- La función pasa a seguir el mismo patrón que sus hermanas: `embedding = NULL`
-- y `WHERE ... IS DISTINCT FROM EXCLUDED.content`, de modo que un UPDATE de
-- `service` que NO toca el texto (precio, is_active, duración) no invalida
-- nada y no gasta una llamada a OpenAI.
--
-- El `CONCAT_WS` se mantiene EXACTAMENTE igual: cambiarlo haría que el texto
-- de cada servicio "cambie" en su próxima edición y dispararía un recálculo
-- masivo innecesario.
--
-- No hay backfill acá a propósito: invalidar los 136 vectores de una obligaría
-- a recalcularlos todos y dejaría el buscador a medias mientras tanto. Los
-- vectores existentes siguen sirviendo; a partir de ahora, cada servicio que
-- se edite se recalcula solo.

-- Primero, la condición de la que depende todo lo de abajo: la columna tiene
-- que aceptar NULL. En producción YA lo acepta; en la base local quedó como
-- NOT NULL (el `init.sql` la creó así y a producción la relajaron después).
-- Sin esto la función falla con "null value in column embedding violates
-- not-null constraint" y la edición del servicio se cae entera. La migración
-- establece la condición en vez de darla por supuesta: es idempotente, y en
-- producción no hace nada.
ALTER TABLE service_embeddings ALTER COLUMN embedding DROP NOT NULL;

CREATE OR REPLACE FUNCTION trg_service_embeddings_sync_fn()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO service_embeddings (service_id, content, embedding, updated_at)
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
    NULL,
    now()
  )
  ON CONFLICT (service_id) DO UPDATE
    SET content = EXCLUDED.content,
        -- Si cambió el texto, el vector viejo ya no lo representa: se invalida
        -- y el embedding-calculator lo vuelve a calcular.
        embedding = NULL,
        updated_at = now()
   WHERE service_embeddings.content IS DISTINCT FROM EXCLUDED.content;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_service_embeddings_sync ON service;

CREATE TRIGGER trg_service_embeddings_sync
AFTER INSERT OR UPDATE ON service
FOR EACH ROW EXECUTE FUNCTION trg_service_embeddings_sync_fn();

-- Verificación (correr aparte):
-- SELECT proname, (prosrc ILIKE '%embedding = NULL%') AS invalida
--   FROM pg_proc WHERE proname LIKE 'trg_%embeddings_sync%' ORDER BY 1;
