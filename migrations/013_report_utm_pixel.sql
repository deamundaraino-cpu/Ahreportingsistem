-- ════════════════════════════════════════════════════════════════
-- Migration 013: report-utm Fase 3 — pixel_events
-- ════════════════════════════════════════════════════════════════
-- Agrega la tabla `pixel_events` para registrar:
--   - Clicks en tracking links (/t/:slug)
--   - Pageviews y eventos custom desde el pixel JS
-- Permite cruce con sales_events vía visitor_id / click_id.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS report_utm.pixel_events (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    cliente_id UUID REFERENCES report_utm.clientes(id) ON DELETE CASCADE NOT NULL,
    link_id UUID REFERENCES report_utm.tracking_links(id) ON DELETE SET NULL,

    event_type TEXT NOT NULL, -- 'click' | 'pageview' | 'custom'
    event_name TEXT,           -- para event_type='custom' (lead, addtocart, etc)

    -- Identificadores de visitante
    visitor_id TEXT,    -- cookie persistente (90d)
    session_id TEXT,    -- cookie de sesión

    -- Contexto de la página
    page_url TEXT,
    page_title TEXT,
    referrer TEXT,

    -- UTMs y click ids (capturados de URL al momento del evento)
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,
    click_id TEXT,      -- fbclid / gclid / ttclid / etc

    -- Cliente (browser)
    user_agent TEXT,
    ip_country TEXT,
    ip_address INET,

    -- Datos arbitrarios del evento
    custom_data JSONB,

    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rutm_pixel_cliente_time
    ON report_utm.pixel_events(cliente_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rutm_pixel_visitor
    ON report_utm.pixel_events(visitor_id) WHERE visitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rutm_pixel_click_id
    ON report_utm.pixel_events(click_id) WHERE click_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rutm_pixel_link
    ON report_utm.pixel_events(link_id) WHERE link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rutm_pixel_event_type
    ON report_utm.pixel_events(event_type);

ALTER TABLE report_utm.pixel_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage rutm_pixel"
    ON report_utm.pixel_events
    FOR ALL
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());
