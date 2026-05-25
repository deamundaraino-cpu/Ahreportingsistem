-- migrations/020_meta_forms.sql
ALTER TABLE metricas_diarias
    ADD COLUMN IF NOT EXISTS meta_forms JSONB DEFAULT '[]'::jsonb;
