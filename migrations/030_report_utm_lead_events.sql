-- ============================================================
-- 030_report_utm_lead_events.sql
-- Tabla dedicada para leads/envíos de formularios
-- ============================================================

CREATE TABLE IF NOT EXISTS report_utm.lead_events (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id      UUID        NOT NULL REFERENCES report_utm.clientes(id) ON DELETE CASCADE,

    -- Origen del formulario
    form_name       TEXT,
    form_id         TEXT,
    form_plugin     TEXT,    -- 'elementor' | 'cf7' | 'gravity_forms' | 'wpforms' | 's2s' | 'manual'

    -- Datos de contacto del lead
    lead_name       TEXT,
    lead_email      TEXT,
    lead_phone      TEXT,

    -- UTM (mismos campos que sales_events)
    utm_source      TEXT,
    utm_medium      TEXT,
    utm_campaign    TEXT,
    utm_content     TEXT,
    utm_term        TEXT,
    utm_id          TEXT,
    click_id        TEXT,    -- fbclid, gclid, etc.

    -- Tracking del visitante
    visitor_id      TEXT,    -- cookie rutm_vid (90d)
    session_id      TEXT,

    -- Metadatos de la request
    page_url        TEXT,
    referrer        TEXT,
    ip_address      INET,
    ip_country      TEXT,
    user_agent      TEXT,

    -- Atribución multi-touch (mismo patrón que sales_events)
    first_touch              JSONB,
    last_touch               JSONB,
    attribution_method       TEXT CHECK (attribution_method IN ('click_id', 'visitor_cookie', 'utm_only', 'none')),
    attribution_resolved_at  TIMESTAMPTZ,

    -- Datos extra
    custom_data     JSONB,
    source          TEXT DEFAULT 's2s',   -- 'js' | 's2s'
    raw_fields      JSONB,               -- todos los campos del formulario sin filtrar

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_rutm_lead_events_cliente
    ON report_utm.lead_events (cliente_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rutm_lead_events_visitor
    ON report_utm.lead_events (visitor_id)
    WHERE visitor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rutm_lead_events_utm
    ON report_utm.lead_events (cliente_id, utm_source, utm_campaign);

CREATE INDEX IF NOT EXISTS idx_rutm_lead_events_email
    ON report_utm.lead_events (cliente_id, lead_email)
    WHERE lead_email IS NOT NULL;

-- RLS
ALTER TABLE report_utm.lead_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE report_utm.lead_events IS 'Leads capturados desde formularios WordPress (Elementor Pro, CF7, GF, WPForms) vía endpoint S2S';
COMMENT ON COLUMN report_utm.lead_events.raw_fields IS 'Todos los campos del formulario tal como los envió WordPress, sin filtrar';
COMMENT ON COLUMN report_utm.lead_events.source IS '''s2s'' = desde PHP server; ''js'' = desde pixel browser';
