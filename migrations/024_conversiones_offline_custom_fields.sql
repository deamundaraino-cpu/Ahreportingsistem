-- ════════════════════════════════════════════════════════════════
-- Migration 024: Campos custom en conversiones_offline_diarias
-- ════════════════════════════════════════════════════════════════
-- Agrega una columna JSONB para almacenar cualquier columna
-- numérica extra del Sheet del cliente. Se exponen en el formula
-- engine con prefijo sheet_ (ej: sheet_citas_agendadas).
-- ════════════════════════════════════════════════════════════════

ALTER TABLE public.conversiones_offline_diarias
    ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}';
