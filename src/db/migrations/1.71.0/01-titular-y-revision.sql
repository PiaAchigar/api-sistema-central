-- ════════════════════════════════════════════════════════════════════════════
-- 1.71.0 / 01 — Unión de contactos: titular, parentesco y conversación por revisar
-- ════════════════════════════════════════════════════════════════════════════
-- Varias personas comparten un mismo WhatsApp (madre/hija, pareja). Hace falta:
--   contacts.holder_contact_id   la titular del WhatsApp que usa esta persona
--                                (NULL = es titular o independiente)
--   contacts.relationship        pareja | hijo | hija | nieto | nieta | otro
--   contacts.relationship_other  texto libre cuando relationship = 'otro'
--   conversations.needs_contact_review  entró por un número compartido sin
--                                titular y Laura tiene que elegir la ficha
-- Índices para que el webhook busque por teléfono/whatsapp_id sin recorrer
-- toda la tabla. "Una persona a cargo no puede ser titular de otras" se valida
-- en la API, no acá.
-- Un único bloque DO: corre entero o no corre. Idempotente.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  ALTER TABLE public.contacts
    ADD COLUMN IF NOT EXISTS holder_contact_id uuid NULL
      REFERENCES public.contacts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS relationship varchar(20) NULL,
    ADD COLUMN IF NOT EXISTS relationship_other varchar(60) NULL;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_contacts_relationship') THEN
    ALTER TABLE public.contacts ADD CONSTRAINT ck_contacts_relationship
      CHECK (relationship IS NULL
             OR relationship IN ('pareja','hijo','hija','nieto','nieta','otro'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_contacts_holder_not_self') THEN
    ALTER TABLE public.contacts ADD CONSTRAINT ck_contacts_holder_not_self
      CHECK (holder_contact_id IS NULL OR holder_contact_id <> id);
  END IF;

  -- No hay CHECK "relationship exige holder": choca con ON DELETE SET NULL (borrar
  -- una titular dejaría a la persona a cargo con relationship y sin holder y
  -- fallaría). Si una corrida anterior lo creó, se borra.
  ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS ck_contacts_relationship_needs_holder;

  CREATE INDEX IF NOT EXISTS ix_contacts_holder
    ON public.contacts (holder_contact_id);
  CREATE INDEX IF NOT EXISTS ix_contacts_phone_clave
    ON public.contacts (right(regexp_replace(phone, '\D', '', 'g'), 10));
  CREATE INDEX IF NOT EXISTS ix_contacts_whatsapp_id
    ON public.contacts (whatsapp_id);

  ALTER TABLE public.conversations
    ADD COLUMN IF NOT EXISTS needs_contact_review boolean NOT NULL DEFAULT false;

  RAISE NOTICE '1.71.0: titular, parentesco, índices y needs_contact_review listos';
END $$;

-- Verificación (correr aparte): 4 columnas y 3 índices.
-- SELECT table_name, column_name FROM information_schema.columns
-- WHERE (table_name = 'contacts' AND column_name IN ('holder_contact_id','relationship','relationship_other'))
--    OR (table_name = 'conversations' AND column_name = 'needs_contact_review');
-- SELECT indexname FROM pg_indexes
-- WHERE indexname IN ('ix_contacts_holder','ix_contacts_phone_clave','ix_contacts_whatsapp_id');
