-- Migration 004: Monthly Reports Engine
-- Creates report_templates and monthly_reports tables.
-- Seeds 3 standard templates (Captación, Infoproducto, Híbrido).

-- ── Templates ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.report_templates (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre        TEXT NOT NULL,
    tipo          TEXT CHECK (tipo IN ('captacion', 'infoproducto', 'hibrido')),
    descripcion   TEXT,
    tarjetas      JSONB DEFAULT '[]',
    columnas      JSONB DEFAULT '[]',
    graficos      JSONB DEFAULT '[]',
    source_mapping JSONB DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- ── Monthly Reports ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.monthly_reports (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id           UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    template_id          UUID REFERENCES public.report_templates(id),
    periodo              TEXT NOT NULL,   -- 'YYYY-MM'
    estado               TEXT DEFAULT 'borrador'
                             CHECK (estado IN ('borrador', 'revision', 'aprobado', 'publicado')),
    campaigns_discovered JSONB DEFAULT '[]',   -- all campaigns with spend > 0 that month
    campaigns_included   JSONB DEFAULT '[]',   -- subset selected for the report
    kpis_snapshot        JSONB DEFAULT '{}',   -- aggregated KPI values at publish time
    public_slug          TEXT UNIQUE,
    pdf_url              TEXT,
    created_by           UUID,
    approved_by          UUID,
    created_at           TIMESTAMPTZ DEFAULT now(),
    updated_at           TIMESTAMPTZ DEFAULT now(),
    UNIQUE(cliente_id, periodo)
);

CREATE INDEX IF NOT EXISTS idx_monthly_reports_cliente
    ON public.monthly_reports(cliente_id, periodo DESC);

CREATE INDEX IF NOT EXISTS idx_monthly_reports_slug
    ON public.monthly_reports(public_slug)
    WHERE public_slug IS NOT NULL;

-- ── Seed: 3 standard templates ───────────────────────────────────────────────

INSERT INTO public.report_templates (nombre, tipo, descripcion, tarjetas, source_mapping)
VALUES
(
    'Captación de Leads',
    'captacion',
    'Para clientes enfocados en generación de leads con Meta Ads. Muestra Gasto, CPL, Leads y ROAS.',
    '[
        {"id":"t_spend","label":"Gasto Total","formula":"meta_spend","prefix":"$","suffix":"","decimals":2,"color":"default"},
        {"id":"t_leads","label":"Leads","formula":"$conversiones","prefix":"","suffix":"","decimals":0,"color":"emerald"},
        {"id":"t_cpl","label":"CPL","formula":"meta_cpl","prefix":"$","suffix":"","decimals":2,"color":"amber"},
        {"id":"t_impressions","label":"Impresiones","formula":"meta_impressions","prefix":"","suffix":"","decimals":0,"color":"default"},
        {"id":"t_ctr","label":"CTR","formula":"meta_ctr","prefix":"","suffix":"%","decimals":2,"color":"default"},
        {"id":"t_landing","label":"Visitas","formula":"$visitas","prefix":"","suffix":"","decimals":0,"color":"blue"}
    ]',
    '{
        "$visitas": "meta_landing_page_views",
        "$conversiones": "meta_leads",
        "$pagos_iniciados": "meta_initiates_checkout"
    }'
),
(
    'Infoproducto Hotmart',
    'infoproducto',
    'Para infoproductores con ventas en Hotmart. Muestra Gasto, Ventas, ROAS y CPV.',
    '[
        {"id":"t_spend","label":"Gasto Meta","formula":"meta_spend","prefix":"$","suffix":"","decimals":2,"color":"default"},
        {"id":"t_ventas","label":"Ventas (USD)","formula":"ventas_principal + ventas_bump + ventas_upsell","prefix":"$","suffix":"","decimals":2,"color":"emerald"},
        {"id":"t_roas","label":"ROAS","formula":"meta_roas","prefix":"","suffix":"x","decimals":2,"color":"emerald"},
        {"id":"t_leads","label":"Leads","formula":"meta_leads","prefix":"","suffix":"","decimals":0,"color":"blue"},
        {"id":"t_pagos","label":"Pagos Iniciados","formula":"$pagos_iniciados","prefix":"","suffix":"","decimals":0,"color":"amber"},
        {"id":"t_conversiones","label":"Compras","formula":"meta_purchases","prefix":"","suffix":"","decimals":0,"color":"emerald"}
    ]',
    '{
        "$visitas": "meta_landing_page_views",
        "$conversiones": "meta_purchases",
        "$pagos_iniciados": "hotmart_pagos_iniciados"
    }'
),
(
    'Híbrido GA4 + Meta',
    'hibrido',
    'Para clientes con GA4 configurado. Visitas desde GA4, conversiones y gasto desde Meta.',
    '[
        {"id":"t_sessions","label":"Sesiones GA4","formula":"$visitas","prefix":"","suffix":"","decimals":0,"color":"blue"},
        {"id":"t_spend","label":"Gasto Meta","formula":"meta_spend","prefix":"$","suffix":"","decimals":2,"color":"default"},
        {"id":"t_leads","label":"Leads","formula":"$conversiones","prefix":"","suffix":"","decimals":0,"color":"emerald"},
        {"id":"t_cpl","label":"CPL","formula":"meta_cpl","prefix":"$","suffix":"","decimals":2,"color":"amber"},
        {"id":"t_ctr","label":"CTR","formula":"meta_ctr","prefix":"","suffix":"%","decimals":2,"color":"default"},
        {"id":"t_bounce","label":"Tasa de Rebote","formula":"ga_bounce_rate","prefix":"","suffix":"%","decimals":1,"color":"default"}
    ]',
    '{
        "$visitas": "ga_sessions",
        "$conversiones": "meta_leads",
        "$pagos_iniciados": "meta_initiates_checkout"
    }'
)
ON CONFLICT DO NOTHING;
