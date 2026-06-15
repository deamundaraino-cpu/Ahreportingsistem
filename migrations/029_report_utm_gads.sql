-- Fase 10: Google Ads Offline Conversions
-- Añade campos para trackear el estado del envío a Google Ads

ALTER TABLE report_utm.sales_events
    ADD COLUMN IF NOT EXISTS gads_sent_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS gads_response  JSONB;

-- Índice parcial para consultas de pendientes
CREATE INDEX IF NOT EXISTS idx_rutm_sales_gads_pending
    ON report_utm.sales_events (cliente_id, created_at DESC)
    WHERE gads_sent_at IS NULL AND status = 'approved';

COMMENT ON COLUMN report_utm.sales_events.gads_sent_at IS 'Timestamp del último envío a Google Ads Offline Conversions API';
COMMENT ON COLUMN report_utm.sales_events.gads_response IS 'Respuesta cruda de Google Ads API (ok, error, partialFailure)';
