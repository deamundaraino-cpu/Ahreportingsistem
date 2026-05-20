-- Migration: Add TikTok metrics columns to metricas_diarias
ALTER TABLE public.metricas_diarias 
ADD COLUMN IF NOT EXISTS tiktok_spend DECIMAL DEFAULT 0,
ADD COLUMN IF NOT EXISTS tiktok_impressions INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS tiktok_clicks INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS tiktok_conversions INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS tiktok_campaigns JSONB DEFAULT '[]'::jsonb;

