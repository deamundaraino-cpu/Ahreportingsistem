-- ============================================================
-- 035_report_utm_meta_leads.sql
-- Soporte para leads de Meta Lead Ads (formularios instantáneos)
--
-- Los leads de Meta llegan vía webhook (tiempo real) y polling (red
-- de seguridad + backfill). Ambos pueden traer el mismo lead, así que
-- guardamos el leadgen_id de Meta en `external_id` y deduplicamos con
-- un índice único parcial por (cliente_id, external_id).
--
-- No se requieren cambios de CHECK: form_plugin, source y integrations.tipo
-- son TEXT libres. Los nuevos valores que se usan son:
--   · lead_events.form_plugin = 'meta_lead_ads'
--   · lead_events.source      = 'meta_lead_ads'
--   · integrations.tipo       = 'meta_lead_ads'
-- ============================================================

-- id externo del lead en la plataforma de origen (leadgen_id de Meta)
ALTER TABLE report_utm.lead_events
    ADD COLUMN IF NOT EXISTS external_id TEXT;

COMMENT ON COLUMN report_utm.lead_events.external_id IS
    'ID del lead en la plataforma de origen (ej. leadgen_id de Meta Lead Ads). Usado para dedup entre webhook y polling.';

-- Dedup/idempotencia: un mismo external_id no se inserta dos veces por cliente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rutm_lead_events_external
    ON report_utm.lead_events (cliente_id, external_id)
    WHERE external_id IS NOT NULL;
