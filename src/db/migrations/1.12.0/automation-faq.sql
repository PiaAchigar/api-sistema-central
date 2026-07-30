-- src/db/migrations/1.12.0/automation-faq.sql
CREATE TABLE IF NOT EXISTS automation_faqs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question    VARCHAR(255),
  answer      TEXT NOT NULL,
  keywords    TEXT[] NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMP DEFAULT now(),
  updated_at  TIMESTAMP DEFAULT now()
);
