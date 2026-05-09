-- ════════════════════════════════════════════════════════════════
-- Migration 012: report-utm module — isolated schema
-- ════════════════════════════════════════════════════════════════
-- Fase 0: scaffolding. Crea schema separado `report_utm` con tablas
-- vacías + RLS. NO toca nada de `public.*` (reporting actual queda
-- intacto). El módulo es admin-only por ahora (clientes no acceden).
--
-- Para que supabase-js pueda llamar `.schema('report_utm')`, agregar
-- "report_utm" a Settings → API → Exposed schemas en Supabase Studio.
-- ════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS report_utm;

-- Permisos básicos (Supabase los administra, pero los seteamos por claridad)
GRANT USAGE ON SCHEMA report_utm TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA report_utm
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- Helper: role check reutilizando public.user_profiles
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION report_utm.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = auth.uid()
          AND role IN ('admin', 'superadmin')
    );
$$;

-- ────────────────────────────────────────────────────────────────
-- Clientes del módulo (separados de public.clientes a propósito)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE report_utm.clientes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    nombre TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    descripcion TEXT,
    color TEXT DEFAULT 'blue',
    -- Link opcional al cliente del reporting principal (si quieren cruzar después)
    public_cliente_id UUID REFERENCES public.clientes(id) ON DELETE SET NULL,
    config JSONB DEFAULT '{}'::jsonb NOT NULL,
    status TEXT DEFAULT 'active', -- active | paused | archived
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_rutm_clientes_status ON report_utm.clientes(status);
CREATE INDEX idx_rutm_clientes_public ON report_utm.clientes(public_cliente_id);

ALTER TABLE report_utm.clientes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage rutm_clientes"
    ON report_utm.clientes
    FOR ALL
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

-- ────────────────────────────────────────────────────────────────
-- Integraciones (Hotmart / Meta / Google) por cliente del módulo
-- ────────────────────────────────────────────────────────────────
CREATE TABLE report_utm.integrations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    cliente_id UUID REFERENCES report_utm.clientes(id) ON DELETE CASCADE NOT NULL,
    tipo TEXT NOT NULL, -- 'hotmart' | 'meta' | 'google' | 'cartpanda' | 'shopify'
    webhook_secret TEXT, -- para validar HMAC entrante
    access_token_encrypted TEXT,
    refresh_token_encrypted TEXT,
    config JSONB DEFAULT '{}'::jsonb NOT NULL,
    status TEXT DEFAULT 'active', -- active | error | inactive
    last_sync_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    UNIQUE(cliente_id, tipo)
);

CREATE INDEX idx_rutm_integrations_cliente ON report_utm.integrations(cliente_id);
CREATE INDEX idx_rutm_integrations_tipo ON report_utm.integrations(tipo);

ALTER TABLE report_utm.integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage rutm_integrations"
    ON report_utm.integrations
    FOR ALL
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

-- ────────────────────────────────────────────────────────────────
-- Sales events: evento crudo por venta (corazón del módulo)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE report_utm.sales_events (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    cliente_id UUID REFERENCES report_utm.clientes(id) ON DELETE CASCADE NOT NULL,

    -- Identificadores externos
    platform TEXT NOT NULL, -- 'hotmart' | 'cartpanda' | 'shopify' | 'manual' | ...
    platform_sale_id TEXT NOT NULL, -- id en la plataforma origen

    -- Datos financieros
    amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    currency TEXT DEFAULT 'BRL',
    status TEXT DEFAULT 'approved', -- approved | pending | refunded | chargeback

    -- UTM parameters
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,
    utm_id TEXT,

    -- Ad-platform identifiers (para atribución directa)
    ad_account_id TEXT,
    ad_campaign_id TEXT,
    ad_set_id TEXT,
    ad_id TEXT,
    placement TEXT,
    click_id TEXT, -- fbclid, gclid, ttclid, etc

    -- Cliente final
    customer_id TEXT,
    customer_name TEXT,
    customer_email TEXT,
    customer_phone TEXT,
    customer_country TEXT,

    -- Producto
    product_id TEXT,
    product_name TEXT,
    transaction_type TEXT, -- 'principal' | 'bump' | 'upsell' | 'subscription'

    -- Raw data (no perdemos nada de lo que llega)
    raw_payload JSONB,

    -- Timestamps
    sale_timestamp TIMESTAMPTZ,
    received_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

    UNIQUE(cliente_id, platform, platform_sale_id)
);

CREATE INDEX idx_rutm_sales_cliente_time ON report_utm.sales_events(cliente_id, sale_timestamp DESC);
CREATE INDEX idx_rutm_sales_utm ON report_utm.sales_events(cliente_id, utm_source, utm_campaign);
CREATE INDEX idx_rutm_sales_platform ON report_utm.sales_events(platform);
CREATE INDEX idx_rutm_sales_status ON report_utm.sales_events(status);
CREATE INDEX idx_rutm_sales_click_id ON report_utm.sales_events(click_id) WHERE click_id IS NOT NULL;

ALTER TABLE report_utm.sales_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage rutm_sales"
    ON report_utm.sales_events
    FOR ALL
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

-- ────────────────────────────────────────────────────────────────
-- Tracking links: links cortos /t/:slug con UTMs precargados
-- ────────────────────────────────────────────────────────────────
CREATE TABLE report_utm.tracking_links (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    cliente_id UUID REFERENCES report_utm.clientes(id) ON DELETE CASCADE NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    destination_url TEXT NOT NULL,

    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,

    clicks_count INTEGER DEFAULT 0,
    last_click_at TIMESTAMPTZ,
    enabled BOOLEAN DEFAULT TRUE,

    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_rutm_links_cliente ON report_utm.tracking_links(cliente_id);
CREATE INDEX idx_rutm_links_slug ON report_utm.tracking_links(slug) WHERE enabled = TRUE;

ALTER TABLE report_utm.tracking_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage rutm_links"
    ON report_utm.tracking_links
    FOR ALL
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

-- ────────────────────────────────────────────────────────────────
-- Hourly metrics: agregación pre-calculada para dashboard rápido
-- ────────────────────────────────────────────────────────────────
CREATE TABLE report_utm.hourly_metrics (
    cliente_id UUID REFERENCES report_utm.clientes(id) ON DELETE CASCADE NOT NULL,
    hour TIMESTAMPTZ NOT NULL,
    utm_source TEXT DEFAULT '',
    utm_campaign TEXT DEFAULT '',
    sales_count INTEGER DEFAULT 0,
    total_revenue NUMERIC(12, 2) DEFAULT 0,
    refunds_count INTEGER DEFAULT 0,
    refunds_amount NUMERIC(12, 2) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    PRIMARY KEY (cliente_id, hour, utm_source, utm_campaign)
);

CREATE INDEX idx_rutm_hourly_hour ON report_utm.hourly_metrics(hour DESC);

ALTER TABLE report_utm.hourly_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage rutm_hourly"
    ON report_utm.hourly_metrics
    FOR ALL
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

-- ────────────────────────────────────────────────────────────────
-- Trigger: actualizar updated_at automáticamente
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION report_utm.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_rutm_clientes_updated
    BEFORE UPDATE ON report_utm.clientes
    FOR EACH ROW EXECUTE FUNCTION report_utm.set_updated_at();

CREATE TRIGGER trg_rutm_integrations_updated
    BEFORE UPDATE ON report_utm.integrations
    FOR EACH ROW EXECUTE FUNCTION report_utm.set_updated_at();

CREATE TRIGGER trg_rutm_links_updated
    BEFORE UPDATE ON report_utm.tracking_links
    FOR EACH ROW EXECUTE FUNCTION report_utm.set_updated_at();
