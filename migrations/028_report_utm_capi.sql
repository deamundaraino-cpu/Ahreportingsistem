-- Fase 8: Meta Conversions API (CAPI)
-- Columnas para registrar el envío de conversiones a Meta

ALTER TABLE report_utm.sales_events
    ADD COLUMN IF NOT EXISTS capi_sent_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS capi_event_id  TEXT,
    ADD COLUMN IF NOT EXISTS capi_response  JSONB;

-- Índice para cron de reintentos (ventas aprobadas sin CAPI enviado)
CREATE INDEX IF NOT EXISTS idx_rutm_sales_capi_pending
    ON report_utm.sales_events(cliente_id, capi_sent_at)
    WHERE capi_sent_at IS NULL AND status = 'approved';

-- La config de Meta CAPI se guarda en integrations con tipo='meta':
-- config JSONB: { "pixel_id": "...", "test_event_code": "..." }
-- access_token_encrypted: token cifrado con AES-256-GCM (encryption.ts)
