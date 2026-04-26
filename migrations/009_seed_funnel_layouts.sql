-- ============================================================
-- Migration 009: Layouts predeterminados de Funnel Hotmart
-- ============================================================
-- Inserta 2 plantillas en layouts_reporte:
-- 1. "Funnel Hotmart Completo" — replica exacta del Excel para
--    pestañas que representan un funnel individual (usa $funnel.*)
-- 2. "Panel General Hotmart" — vista consolidada que suma todos
--    los funnels + extras (usa totales globales)
-- ============================================================

-- ─── 1. Layout: Funnel Hotmart Completo ─────────────────────────
INSERT INTO public.layouts_reporte (nombre, columnas, tarjetas, attribution_strategy, source_mapping)
VALUES (
    'Funnel Hotmart Completo',
    -- columnas (ColDef[])
    '[
      { "id": "fecha", "label": "Fecha", "formula": "fecha", "align": "left" },
      { "id": "spend", "label": "Inversión", "formula": "meta_spend", "prefix": "$", "decimals": 2 },
      { "id": "cpm", "label": "CPM", "formula": "meta_cpm", "prefix": "$", "decimals": 2 },
      { "id": "impressions", "label": "Impresiones", "formula": "meta_impressions", "decimals": 0 },
      { "id": "reach", "label": "Alcance", "formula": "meta_reach", "decimals": 0 },
      { "id": "ctr", "label": "CTR", "formula": "meta_ctr", "suffix": "%", "decimals": 2 },
      { "id": "clicks", "label": "Clics", "formula": "meta_link_clicks", "decimals": 0 },
      { "id": "cpc", "label": "CPC", "formula": "meta_cpc_link", "prefix": "$", "decimals": 2 },
      { "id": "visitas", "label": "Visitas", "formula": "ga_sessions", "decimals": 0 },
      { "id": "costo_visita", "label": "Costo/Visita", "formula": "funnel_costo_visita", "prefix": "$", "decimals": 2 },
      { "id": "pct_clics_visitas", "label": "% Clics→Visitas", "formula": "funnel_pct_clics_visitas", "suffix": "%", "decimals": 2 },
      { "id": "pagos_iniciados", "label": "Pagos Iniciados", "formula": "funnel_pagos_iniciados", "decimals": 0 },
      { "id": "costo_pago", "label": "Costo/Pago", "formula": "funnel_costo_pago", "prefix": "$", "decimals": 2 },
      { "id": "pct_visitas_pagos", "label": "% Visitas→Pagos", "formula": "funnel_pct_visitas_pagos", "suffix": "%", "decimals": 2 },
      { "id": "compras", "label": "Compras", "formula": "funnel_principal_count", "decimals": 0, "highlight": true },
      { "id": "costo_compra", "label": "Costo/Compra", "formula": "funnel_costo_compra", "prefix": "$", "decimals": 2 },
      { "id": "pct_pagos_compras", "label": "% Pagos→Compras", "formula": "funnel_pct_pagos_compras", "suffix": "%", "decimals": 2 },
      { "id": "pct_conversion", "label": "% Conv. General", "formula": "funnel_pct_conversion", "suffix": "%", "decimals": 2 },
      { "id": "order_bump_count", "label": "# Order Bump", "formula": "funnel_bump_count", "decimals": 0 },
      { "id": "order_bump_neto", "label": "Neto Order Bump", "formula": "funnel_bump_neto", "prefix": "$", "decimals": 2 },
      { "id": "upsell_count", "label": "# UPSell", "formula": "funnel_upsell_count", "decimals": 0 },
      { "id": "upsell_neto", "label": "Neto UPSELL", "formula": "funnel_upsell_neto", "prefix": "$", "decimals": 2 },
      { "id": "fact_bruta", "label": "Facturación Bruta", "formula": "funnel_facturacion_bruta", "prefix": "$", "decimals": 2 },
      { "id": "fact_neta", "label": "Facturación Neta", "formula": "funnel_facturacion_neta", "prefix": "$", "decimals": 2, "highlight": true },
      { "id": "roas", "label": "ROAS", "formula": "funnel_roas", "suffix": "x", "decimals": 2, "highlight": true },
      { "id": "roi", "label": "ROI", "formula": "funnel_roi", "suffix": "x", "decimals": 2, "highlight": true },
      { "id": "dinero_bolsa", "label": "Dinero en Bolsa", "formula": "funnel_dinero_bolsa", "prefix": "$", "decimals": 2, "highlight": true },
      { "id": "pct_conv_order", "label": "% Conv. Order", "formula": "funnel_pct_conv_order", "suffix": "%", "decimals": 2 },
      { "id": "pct_conv_upsell", "label": "% Conv. UPSELL", "formula": "funnel_pct_conv_upsell", "suffix": "%", "decimals": 2 },
      { "id": "visitas_upsell", "label": "Visitas Pág. Upsell", "formula": "funnel_upsell_visits", "decimals": 0 },
      { "id": "pct_upsell_pago", "label": "% Visita Upsell→Pago", "formula": "funnel_pct_conv_upsell", "suffix": "%", "decimals": 2 }
    ]'::jsonb,
    -- tarjetas (CardDef[])
    '[
      { "id": "card_inversion",   "label": "Inversión Total",   "formula": "meta_spend",                 "prefix": "$", "decimals": 2, "color": "amber" },
      { "id": "card_compras",     "label": "Compras",           "formula": "funnel_principal_count",     "decimals": 0,  "color": "blue" },
      { "id": "card_fact_bruta",  "label": "Facturación Bruta", "formula": "funnel_facturacion_bruta",   "prefix": "$", "decimals": 2, "color": "default" },
      { "id": "card_fact_neta",   "label": "Facturación Neta",  "formula": "funnel_facturacion_neta",    "prefix": "$", "decimals": 2, "color": "emerald" },
      { "id": "card_roas",        "label": "ROAS",              "formula": "funnel_roas",                "suffix": "x", "decimals": 2, "color": "emerald" },
      { "id": "card_roi",         "label": "ROI",               "formula": "funnel_roi",                 "suffix": "x", "decimals": 2, "color": "emerald" },
      { "id": "card_dinero",      "label": "Dinero en Bolsa",   "formula": "funnel_dinero_bolsa",        "prefix": "$", "decimals": 2, "color": "emerald" }
    ]'::jsonb,
    'custom',
    '{}'::jsonb
)
ON CONFLICT DO NOTHING;

-- ─── 2. Layout: Panel General Hotmart ────────────────────────────
INSERT INTO public.layouts_reporte (nombre, columnas, tarjetas, attribution_strategy, source_mapping)
VALUES (
    'Panel General Hotmart',
    -- columnas: misma estructura pero usando totales globales (suma de funnels + extras)
    '[
      { "id": "fecha", "label": "Fecha", "formula": "fecha", "align": "left" },
      { "id": "spend", "label": "Inversión", "formula": "meta_spend", "prefix": "$", "decimals": 2 },
      { "id": "cpm", "label": "CPM", "formula": "meta_cpm", "prefix": "$", "decimals": 2 },
      { "id": "impressions", "label": "Impresiones", "formula": "meta_impressions", "decimals": 0 },
      { "id": "ctr", "label": "CTR", "formula": "meta_ctr", "suffix": "%", "decimals": 2 },
      { "id": "clicks", "label": "Clics", "formula": "meta_link_clicks", "decimals": 0 },
      { "id": "cpc", "label": "CPC", "formula": "meta_cpc_link", "prefix": "$", "decimals": 2 },
      { "id": "visitas", "label": "Visitas (GA4)", "formula": "ga_sessions", "decimals": 0 },
      { "id": "pagos_iniciados", "label": "Pagos Iniciados (GA4)", "formula": "hotmart_pagos_iniciados", "decimals": 0 },
      { "id": "compras", "label": "Compras", "formula": "ventas_principal_count", "decimals": 0, "highlight": true },
      { "id": "costo_compra", "label": "Costo/Compra", "formula": "total_costo_compra", "prefix": "$", "decimals": 2 },
      { "id": "order_bump_count", "label": "# Order Bump", "formula": "ventas_bump_count", "decimals": 0 },
      { "id": "order_bump_neto", "label": "Neto Order Bump", "formula": "ventas_bump", "prefix": "$", "decimals": 2 },
      { "id": "upsell_count", "label": "# UPSell", "formula": "ventas_upsell_count", "decimals": 0 },
      { "id": "upsell_neto", "label": "Neto UPSELL", "formula": "ventas_upsell", "prefix": "$", "decimals": 2 },
      { "id": "fact_bruta", "label": "Facturación Bruta", "formula": "total_facturacion_bruta", "prefix": "$", "decimals": 2 },
      { "id": "fact_neta", "label": "Facturación Neta", "formula": "total_facturacion_neta", "prefix": "$", "decimals": 2, "highlight": true },
      { "id": "roas", "label": "ROAS", "formula": "total_roas", "suffix": "x", "decimals": 2, "highlight": true },
      { "id": "roi", "label": "ROI", "formula": "total_roi", "suffix": "x", "decimals": 2, "highlight": true },
      { "id": "dinero_bolsa", "label": "Dinero en Bolsa", "formula": "total_dinero_bolsa", "prefix": "$", "decimals": 2, "highlight": true }
    ]'::jsonb,
    -- tarjetas: KPIs globales
    '[
      { "id": "card_inversion",   "label": "Inversión Total",         "formula": "meta_spend",                "prefix": "$", "decimals": 2, "color": "amber" },
      { "id": "card_compras",     "label": "Compras (Todos los Funnels)", "formula": "ventas_principal_count","decimals": 0,  "color": "blue" },
      { "id": "card_fact_bruta",  "label": "Facturación Bruta Total", "formula": "total_facturacion_bruta",   "prefix": "$", "decimals": 2, "color": "default" },
      { "id": "card_fact_neta",   "label": "Facturación Neta Total",  "formula": "total_facturacion_neta",    "prefix": "$", "decimals": 2, "color": "emerald" },
      { "id": "card_roas",        "label": "ROAS Global",             "formula": "total_roas",                "suffix": "x", "decimals": 2, "color": "emerald" },
      { "id": "card_dinero",      "label": "Dinero en Bolsa",         "formula": "total_dinero_bolsa",        "prefix": "$", "decimals": 2, "color": "emerald" }
    ]'::jsonb,
    'full_hotmart',
    '{}'::jsonb
)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Seed completed
-- ============================================================
