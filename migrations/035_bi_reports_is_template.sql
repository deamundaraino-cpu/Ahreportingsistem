-- ============================================================
-- 035_bi_reports_is_template.sql
-- Distingue las plantillas del sistema de los informes de usuario
-- con un flag explícito, en vez de inferirlo por cliente_id NULL.
-- ------------------------------------------------------------
-- Antes: "plantilla" = sin cliente_id → impedía borrar informes de
-- usuario sin cliente fijo. Ahora is_template lo marca explícitamente.
-- ============================================================

ALTER TABLE public.bi_reports
    ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT false;

-- Marca como plantillas las 4 sembradas por la migración 032
UPDATE public.bi_reports
SET is_template = true
WHERE cliente_id IS NULL
  AND nombre IN (
    'Rendimiento por Fuente',
    'Tendencia de Leads',
    'ROAS por Campaña',
    'Funnel Completo'
  );
