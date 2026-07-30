-- ════════════════════════════════════════════════════════════════════════════
-- 1.9.0 — Multi-facturador ARCA (varias identidades fiscales)
-- ════════════════════════════════════════════════════════════════════════════
-- Hasta ahora existía UN solo emisor, hardcodeado en las variables del Worker
-- (AFIP_CUIT / AFIP_SDK_TOKEN / AFIP_CERT / AFIP_KEY / ARCA_POS / ARCA_ENV).
-- Con esto cada persona/razón social factura con sus propias credenciales y se
-- elige cuál usar en cada cobranza.
--
-- SECRETOS: sdk_token / cert / key se guardan CIFRADOS (AES-GCM) con la master
-- key del Worker `ARCA_SECRETS_KEY` — ver src/lib/secret-box.ts. Un dump de la
-- base NO alcanza para emitir comprobantes a nombre de nadie. Por eso las
-- columnas son TEXT (base64 de iv||ciphertext) y nunca se devuelven por la API.
--
-- Idempotente: se puede correr más de una vez sin romper.

CREATE TABLE IF NOT EXISTS arca_issuers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(100) NOT NULL,
  cuit              VARCHAR(20)  NOT NULL,
  -- Cifrados con AES-GCM (base64 de iv||ciphertext). Nunca en texto plano.
  sdk_token_enc     TEXT NOT NULL,
  cert_enc          TEXT NOT NULL,
  key_enc           TEXT NOT NULL,
  environment       VARCHAR(10) NOT NULL DEFAULT 'homo',  -- homo | prod
  point_of_sale     INTEGER     NOT NULL DEFAULT 1,
  invoice_type      VARCHAR(10) NOT NULL DEFAULT 'C',     -- A | B | C
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  is_default        BOOLEAN     NOT NULL DEFAULT FALSE,
  notes             TEXT,
  created_at        TIMESTAMP DEFAULT now(),
  updated_at        TIMESTAMP DEFAULT now(),
  CONSTRAINT chk_issuer_environment CHECK (environment IN ('homo', 'prod')),
  CONSTRAINT chk_issuer_pos CHECK (point_of_sale > 0)
);

-- El nombre es lo que se ve en el selector de la cobranza: que no se repita.
CREATE UNIQUE INDEX IF NOT EXISTS uq_arca_issuers_name ON arca_issuers (lower(name));

-- Un CUIT puede tener varios puntos de venta, pero no dos filas iguales.
CREATE UNIQUE INDEX IF NOT EXISTS uq_arca_issuers_cuit_pos
  ON arca_issuers (cuit, point_of_sale, invoice_type);

-- A lo sumo UN facturador por defecto (el que viene preseleccionado).
CREATE UNIQUE INDEX IF NOT EXISTS uq_arca_issuers_single_default
  ON arca_issuers (is_default) WHERE is_default = TRUE;

-- ── invoices: con qué identidad se emitió (o se va a emitir) ────────────────
-- NULL = facturas viejas, anteriores al multi-facturador. La emisión cae al
-- facturador por defecto cuando está en NULL (ver arca/factory.ts).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issuer_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'invoices'::regclass
      AND c.contype = 'f'
      AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
          WHERE attrelid = 'invoices'::regclass AND attname = 'issuer_id')
      ]::smallint[]
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT fk_invoices_issuer
      FOREIGN KEY (issuer_id) REFERENCES arca_issuers(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_issuer ON invoices (issuer_id);
