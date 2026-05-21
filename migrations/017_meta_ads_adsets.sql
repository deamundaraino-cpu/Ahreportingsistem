-- migrations/017_meta_ads_adsets.sql
ALTER TABLE metricas_diarias ADD COLUMN IF NOT EXISTS meta_ads    JSONB DEFAULT '[]'::jsonb;
ALTER TABLE metricas_diarias ADD COLUMN IF NOT EXISTS meta_adsets JSONB DEFAULT '[]'::jsonb;
