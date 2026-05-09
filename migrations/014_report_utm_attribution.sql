-- ════════════════════════════════════════════════════════════════
-- Migration 014: report-utm Fase 4 — atribución multi-touch + outbound
-- ════════════════════════════════════════════════════════════════
-- 1) Columnas de atribución resuelta en sales_events:
--    - visitor_id: cookie persistente del comprador (cuando se logró cruzar)
--    - first_touch: snapshot del primer contacto del visitor
--    - last_touch: snapshot del último contacto previo a la venta
--    - attribution_method: cómo se cruzó (click_id, visitor_cookie, utm_only)
--    - attribution_resolved_at: cuándo corrió el resolver
--
-- 2) Outbound webhooks: emitir eventos a sistemas del cliente
--    cuando se reciben ventas (post-procesamiento).
-- ════════════════════════════════════════════════════════════════

ALTER TABLE report_utm.sales_events
    ADD COLUMN IF NOT EXISTS visitor_id TEXT,
    ADD COLUMN IF NOT EXISTS first_touch JSONB,
    ADD COLUMN IF NOT EXISTS last_touch JSONB,
    ADD COLUMN IF NOT EXISTS attribution_method TEXT, -- 'click_id' | 'visitor_cookie' | 'utm_only' | 'none'
    ADD COLUMN IF NOT EXISTS attribution_resolved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_rutm_sales_visitor
    ON report_utm.sales_events(visitor_id) WHERE visitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rutm_sales_attribution_method
    ON report_utm.sales_events(attribution_method) WHERE attribution_method IS NOT NULL;

-- ────────────────────────────────────────────────────────────────
-- Outbound webhooks: el cliente puede suscribirse a eventos
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_utm.outbound_webhooks (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    cliente_id UUID REFERENCES report_utm.clientes(id) ON DELETE CASCADE NOT NULL,
    nombre TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL, -- HMAC key
    -- Filtro de eventos: array de tipos permitidos.
    --   Ej: ['sale.approved'], ['sale.approved', 'sale.refunded']
    event_types TEXT[] DEFAULT ARRAY['sale.approved']::TEXT[] NOT NULL,
    enabled BOOLEAN DEFAULT TRUE NOT NULL,
    last_fired_at TIMESTAMPTZ,
    last_status INTEGER, -- HTTP status del último intento
    last_error TEXT,
    success_count INTEGER DEFAULT 0 NOT NULL,
    failure_count INTEGER DEFAULT 0 NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rutm_outbound_cliente
    ON report_utm.outbound_webhooks(cliente_id) WHERE enabled = TRUE;

ALTER TABLE report_utm.outbound_webhooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage rutm_outbound"
    ON report_utm.outbound_webhooks
    FOR ALL
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

CREATE TRIGGER trg_rutm_outbound_updated
    BEFORE UPDATE ON report_utm.outbound_webhooks
    FOR EACH ROW EXECUTE FUNCTION report_utm.set_updated_at();

-- ────────────────────────────────────────────────────────────────
-- Log de entregas (auditoría + base para retry futuro)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_utm.outbound_deliveries (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    webhook_id UUID REFERENCES report_utm.outbound_webhooks(id) ON DELETE CASCADE NOT NULL,
    sale_event_id UUID REFERENCES report_utm.sales_events(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    response_status INTEGER,
    response_body TEXT,
    error TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rutm_deliveries_webhook
    ON report_utm.outbound_deliveries(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rutm_deliveries_sale
    ON report_utm.outbound_deliveries(sale_event_id);

ALTER TABLE report_utm.outbound_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage rutm_deliveries"
    ON report_utm.outbound_deliveries
    FOR ALL
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());
