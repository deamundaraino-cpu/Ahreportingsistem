-- migrations/037_conversiones_offline_individual_custom_fields.sql
-- Adds custom_fields JSONB column to conversiones_offline table to support filtering on individual row attributes.

ALTER TABLE public.conversiones_offline
    ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.conversiones_offline.custom_fields IS 'Almacena todos los campos personalizados (incluyendo texto y rangos de datos) de cada registro de lead/venta individual importado de Google Sheets.';
