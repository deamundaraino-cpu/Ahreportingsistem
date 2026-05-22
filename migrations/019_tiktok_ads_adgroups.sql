-- migrations/019_tiktok_ads_adgroups.sql
ALTER TABLE metricas_diarias ADD COLUMN IF NOT EXISTS tiktok_ads       JSONB DEFAULT '[]'::jsonb;
ALTER TABLE metricas_diarias ADD COLUMN IF NOT EXISTS tiktok_adgroups  JSONB DEFAULT '[]'::jsonb;
