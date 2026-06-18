-- ============================================================
-- 032_report_utm_bi_reports.sql
-- Tabla para guardar configuraciones de reportes del BI Builder.
-- ------------------------------------------------------------
-- IMPORTANTE: vive en el schema `public` (no en report_utm) a
-- propósito: el BI Builder cruza datos de report_utm (leads/ventas)
-- con datos de public (metricas_diarias / gasto publicitario), así
-- que la tabla de configuración se coloca en public para evitar
-- problemas de exposición de schema en PostgREST y poder combinar
-- libremente con el resto de los datos.
--
-- `cliente_id` es un UUID suelto (sin FK) que puede apuntar a un
-- report_utm.clientes.id; queda desacoplado a propósito. NULL = plantilla
-- del sistema (visible para todos).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.bi_reports (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id  UUID,
    nombre      TEXT        NOT NULL,
    descripcion TEXT,
    layout      JSONB       NOT NULL DEFAULT '[]',
    filters     JSONB       NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bi_reports_cliente_idx ON public.bi_reports(cliente_id);
CREATE INDEX IF NOT EXISTS bi_reports_created_idx ON public.bi_reports(created_at DESC);

-- Auto-update de updated_at
CREATE OR REPLACE FUNCTION public.set_bi_reports_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bi_reports_updated_at ON public.bi_reports;
CREATE TRIGGER trg_bi_reports_updated_at
    BEFORE UPDATE ON public.bi_reports
    FOR EACH ROW EXECUTE FUNCTION public.set_bi_reports_updated_at();

-- RLS: el módulo usa el service-role key desde el server (createAdminClient),
-- que bypassa RLS. Habilitamos RLS y permitimos lectura a usuarios
-- autenticados para que sea seguro si en el futuro se consulta desde el cliente.
ALTER TABLE public.bi_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bi_reports_select ON public.bi_reports;
CREATE POLICY bi_reports_select ON public.bi_reports
    FOR SELECT TO authenticated USING (true);

-- Plantillas predefinidas (cliente_id = NULL = disponibles para todos).
INSERT INTO public.bi_reports (nombre, descripcion, layout, filters) VALUES
(
    'Rendimiento por Fuente',
    'Distribución de leads y ventas por UTM source con métricas clave.',
    '[
        {"id":"sc-leads","type":"scorecard","title":"Total Leads","w":1,"h":1,"config":{"metric":"leads_count","dimension":"none"}},
        {"id":"sc-sales","type":"scorecard","title":"Total Ventas","w":1,"h":1,"config":{"metric":"sales_count","dimension":"none"}},
        {"id":"sc-revenue","type":"scorecard","title":"Revenue","w":1,"h":1,"config":{"metric":"revenue","dimension":"none"}},
        {"id":"sc-conv","type":"scorecard","title":"Tasa Conversión","w":1,"h":1,"config":{"metric":"conversion_rate","dimension":"none"}},
        {"id":"bar-source","type":"bar","title":"Leads por Source","w":2,"h":2,"config":{"metric":"leads_count","dimension":"utm_source"}},
        {"id":"pie-source","type":"pie","title":"Revenue por Source","w":2,"h":2,"config":{"metric":"revenue","dimension":"utm_source"}}
    ]'::jsonb,
    '{"days":30}'::jsonb
),
(
    'Tendencia de Leads',
    'Evolución temporal de leads y ventas con scorecards de CPL.',
    '[
        {"id":"sc-leads","type":"scorecard","title":"Total Leads","w":1,"h":1,"config":{"metric":"leads_count","dimension":"none"}},
        {"id":"sc-cpl","type":"scorecard","title":"CPL","w":1,"h":1,"config":{"metric":"cpl","dimension":"none"}},
        {"id":"line-leads","type":"line","title":"Leads por Día","w":4,"h":2,"config":{"metric":"leads_count","dimension":"date","date_grouping":"day"}},
        {"id":"table-campaign","type":"table","title":"Por Campaña","w":4,"h":2,"config":{"metric":"leads_count,revenue","dimension":"utm_campaign"}}
    ]'::jsonb,
    '{"days":30}'::jsonb
),
(
    'ROAS por Campaña',
    'Rentabilidad publicitaria comparando gasto con revenue generado.',
    '[
        {"id":"sc-spend","type":"scorecard","title":"Gasto Total","w":1,"h":1,"config":{"metric":"spend","dimension":"none"}},
        {"id":"sc-revenue","type":"scorecard","title":"Revenue","w":1,"h":1,"config":{"metric":"revenue","dimension":"none"}},
        {"id":"sc-roas","type":"scorecard","title":"ROAS","w":1,"h":1,"config":{"metric":"roas","dimension":"none"}},
        {"id":"sc-cpa","type":"scorecard","title":"CPA","w":1,"h":1,"config":{"metric":"cpa","dimension":"none"}},
        {"id":"bar-campaign","type":"bar","title":"ROAS por Campaña","w":4,"h":2,"config":{"metric":"roas","dimension":"utm_campaign"}},
        {"id":"table-source","type":"table","title":"Spend vs Revenue por Source","w":4,"h":2,"config":{"metric":"spend,revenue,roas","dimension":"utm_source"}}
    ]'::jsonb,
    '{"days":30}'::jsonb
),
(
    'Funnel Completo',
    'Visión embudo desde impresiones hasta conversiones finales.',
    '[
        {"id":"funnel","type":"funnel","title":"Funnel de Conversión","w":4,"h":3,"config":{"metrics":["impressions","clicks","leads_count","sales_count"]}},
        {"id":"table-utm","type":"table","title":"UTM Completo","w":4,"h":2,"config":{"metric":"leads_count,sales_count,revenue,conversion_rate","dimension":"utm_source"}}
    ]'::jsonb,
    '{"days":30}'::jsonb
)
ON CONFLICT DO NOTHING;
