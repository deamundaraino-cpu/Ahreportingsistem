-- migrations/044_bi_report_deliveries.sql
-- Historial de entregas de informes BI programados.
--
-- Cada envío del cron (semanal / quincenal / mensual) registra una fila con el
-- período reportado y su propio token público. El link de la entrega muestra el
-- informe calculado en vivo pero con el rango de fechas CONGELADO en el período,
-- de modo que "Semana 2 de Julio 2026" siempre significa lo mismo.
--
-- El UNIQUE(report_id, period_label) es además el mecanismo de deduplicación:
-- si el cron se ejecuta dos veces en la misma hora/ocurrencia, el segundo INSERT
-- falla y el envío se omite.

CREATE TABLE IF NOT EXISTS public.bi_report_deliveries (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id      UUID NOT NULL REFERENCES public.bi_reports(id) ON DELETE CASCADE,
    period_type    TEXT NOT NULL CHECK (period_type IN ('weekly', 'biweekly', 'monthly')),
    -- Etiqueta legible para el cliente: 'Semana 2 de Julio 2026',
    -- '1ra quincena de Julio 2026', 'Julio 2026'.
    period_label   TEXT NOT NULL,
    date_from      DATE NOT NULL,
    date_to        DATE NOT NULL,
    -- Token público propio de esta entrega → /report/bi/d/<delivery_token>
    delivery_token TEXT NOT NULL UNIQUE,
    sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Resultado por canal: { "email": {...}, "whatsapp": {...} }
    sent_to        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (report_id, period_label)
);

CREATE INDEX IF NOT EXISTS idx_bi_report_deliveries_report
    ON public.bi_report_deliveries(report_id, sent_at DESC);

COMMENT ON TABLE public.bi_report_deliveries IS
    'Historial de entregas de informes BI programados. Cada fila = un período enviado, con su link público de rango congelado.';
COMMENT ON COLUMN public.bi_report_deliveries.period_label IS
    'Etiqueta del período mostrada al cliente. Único por informe → sirve de dedup del cron.';
COMMENT ON COLUMN public.bi_report_deliveries.delivery_token IS
    'Token del link público de esta entrega: /report/bi/d/<token>.';

-- ── Autoría de los informes ──────────────────────────────────────────────────
-- Permite distinguir las plantillas del SISTEMA (sembradas, created_by NULL) de
-- las plantillas creadas por el equipo, que sí se pueden borrar.
ALTER TABLE public.bi_reports
    ADD COLUMN IF NOT EXISTS created_by UUID;

COMMENT ON COLUMN public.bi_reports.created_by IS
    'Usuario que creó el informe/plantilla. NULL = plantilla del sistema (protegida contra borrado).';

-- ── Plantilla "Reporte de Cliente" ───────────────────────────────────────────
-- Punto de partida para los informes que se envían a clientes: resumen en
-- lenguaje simple, KPIs con comparación vs. período anterior, funnel, tendencia
-- diaria y desglose por campaña cruzada.
INSERT INTO public.bi_reports (nombre, descripcion, cliente_id, is_template, layout, filters)
SELECT
    'Reporte de Cliente',
    'Plantilla lista para enviar: resumen ejecutivo, KPIs comparados, funnel, tendencia y campañas.',
    NULL,
    true,
    '[
      {"id":"tpl_h1","type":"heading","title":"Resultados del período","w":4,"h":1,
       "config":{"heading_level":1,"align":"left","accent":"#10b981"}},
      {"id":"tpl_sum","type":"summary","title":"Resumen del período","w":4,"h":1,
       "config":{"accent":"#10b981"}},
      {"id":"tpl_spend","type":"scorecard","title":"Inversión publicitaria","w":1,"h":1,
       "config":{"metric":"spend","compare_period":true}},
      {"id":"tpl_leads","type":"scorecard","title":"Contactos generados","w":1,"h":1,
       "config":{"metric":"leads_count","compare_period":true}},
      {"id":"tpl_cpl","type":"scorecard","title":"Costo por contacto","w":1,"h":1,
       "config":{"metric":"cpl","compare_period":true}},
      {"id":"tpl_roas","type":"scorecard","title":"Retorno (ROAS)","w":1,"h":1,
       "config":{"metric":"roas","compare_period":true}},
      {"id":"tpl_funnel","type":"funnel","title":"Embudo de conversión","w":2,"h":2,
       "config":{"metrics":["impressions","clicks","leads_count","sales_count"]}},
      {"id":"tpl_trend","type":"line","title":"Evolución diaria de contactos","w":2,"h":2,
       "config":{"metric":"leads_count","dimension":"date","date_grouping":"day","color":"#10b981"}},
      {"id":"tpl_camp","type":"table","title":"Resultados por campaña","w":4,"h":2,
       "config":{"metric":"spend,leads_count,cpl,sales_count,revenue,roas","dimension":"campaign",
                 "limit":15,"sort":"desc","show_totals":true}}
    ]'::jsonb,
    '{}'::jsonb
WHERE NOT EXISTS (
    SELECT 1 FROM public.bi_reports WHERE nombre = 'Reporte de Cliente' AND is_template = true
);
