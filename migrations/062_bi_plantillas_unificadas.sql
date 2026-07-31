-- ============================================================
-- 062_bi_plantillas_unificadas.sql
-- Plantillas de arranque del BI con las dimensiones unificadas.
-- ------------------------------------------------------------
-- GENERADO por scripts/seed-bi-plantillas.ts — no editar a mano.
--
-- Las cuatro plantillas de la migración 032 se escribieron cuando el gasto
-- no cruzaba con los leads: sus tablas por campaña mezclaban columnas que
-- salían siempre en 0. Estas tres usan el cruce real (utm_campaign ya
-- resuelve contra las campañas del reporting) y solo métricas recomendadas,
-- así que un informe nuevo arranca mostrando datos.
--
-- IDEMPOTENTE: reejecutarla actualiza el layout en vez de fallar por nombre
-- duplicado. La cláusula de conflicto reproduce el predicado EXACTO del índice
-- que hay en producción:
--
--   CREATE UNIQUE INDEX bi_reports_system_template_nombre_uq
--       ON public.bi_reports (nombre)
--       WHERE (is_template IS TRUE AND created_by IS NULL)
--
-- Ese índice NO está en ninguna migración de este repo: se creó directo en la
-- base (ver docs/04-modelo-de-datos.md, "objetos sin migración"). Por eso las
-- filas se insertan con created_by = NULL explícito, que es lo que las mete
-- dentro del alcance del índice y hace que el ON CONFLICT las alcance.
-- ============================================================

INSERT INTO public.bi_reports
    (nombre, descripcion, layout, filters, is_template, cliente_id, created_by)
VALUES
(
    'Rendimiento por campaña',
    'Qué campaña trae los contactos y a qué costo. Cruza leads, gasto y ventas por el nombre real de la campaña.',
    '[
    {
        "id": "h-resumen",
        "type": "heading",
        "title": "Resumen del período",
        "w": 4,
        "h": 1,
        "config": {
            "heading_level": 1,
            "accent": "#10b981"
        }
    },
    {
        "id": "kpi-spend",
        "type": "scorecard",
        "title": "Inversión",
        "w": 1,
        "h": 1,
        "config": {
            "metric": "spend",
            "dimension": "none",
            "compare_period": true
        }
    },
    {
        "id": "kpi-leads",
        "type": "scorecard",
        "title": "Contactos",
        "w": 1,
        "h": 1,
        "config": {
            "metric": "leads_count",
            "dimension": "none",
            "compare_period": true
        }
    },
    {
        "id": "kpi-cpl",
        "type": "scorecard",
        "title": "Costo por contacto",
        "w": 1,
        "h": 1,
        "config": {
            "metric": "cpl",
            "dimension": "none",
            "compare_period": true
        }
    },
    {
        "id": "kpi-roas",
        "type": "scorecard",
        "title": "Retorno (ROAS)",
        "w": 1,
        "h": 1,
        "config": {
            "metric": "roas",
            "dimension": "none",
            "compare_period": true
        }
    },
    {
        "id": "sum-1",
        "type": "summary",
        "title": "Cómo fue el período",
        "w": 4,
        "h": 1,
        "config": {}
    },
    {
        "id": "h-campanas",
        "type": "heading",
        "title": "Detalle por campaña",
        "w": 4,
        "h": 1,
        "config": {
            "heading_level": 2
        }
    },
    {
        "id": "tbl-campanas",
        "type": "table",
        "title": "Campañas",
        "w": 4,
        "h": 2,
        "config": {
            "metric": "spend,leads_count,cpl,sales_count,roas",
            "dimension": "utm_campaign",
            "limit": 20,
            "sort": "desc",
            "show_totals": true
        }
    },
    {
        "id": "h-evolucion",
        "type": "heading",
        "title": "Evolución y creatividades",
        "w": 4,
        "h": 1,
        "config": {
            "heading_level": 2
        }
    },
    {
        "id": "line-leads",
        "type": "line",
        "title": "Contactos por día",
        "w": 2,
        "h": 2,
        "config": {
            "metric": "leads_count",
            "dimension": "date",
            "date_grouping": "day",
            "color": "#10b981"
        }
    },
    {
        "id": "bar-ads",
        "type": "bar",
        "title": "Inversión por anuncio",
        "w": 2,
        "h": 2,
        "config": {
            "metric": "spend",
            "dimension": "ad",
            "limit": 10,
            "sort": "desc",
            "color": "#8b5cf6"
        }
    }
]'::jsonb,
    '{}'::jsonb,
    true,
    NULL,
    NULL
),
(
    'Origen y atribución',
    'De dónde vienen los contactos y cómo avanzan hasta la venta. Source, medium y embudo completo.',
    '[
    {
        "id": "h-origen",
        "type": "heading",
        "title": "De dónde vienen los contactos",
        "w": 4,
        "h": 1,
        "config": {
            "heading_level": 1,
            "accent": "#06b6d4"
        }
    },
    {
        "id": "kpi-leads",
        "type": "scorecard",
        "title": "Contactos",
        "w": 1,
        "h": 1,
        "config": {
            "metric": "leads_count",
            "dimension": "none",
            "compare_period": true
        }
    },
    {
        "id": "kpi-sales",
        "type": "scorecard",
        "title": "Ventas",
        "w": 1,
        "h": 1,
        "config": {
            "metric": "sales_count",
            "dimension": "none",
            "compare_period": true
        }
    },
    {
        "id": "kpi-conv",
        "type": "scorecard",
        "title": "Tasa de conversión",
        "w": 1,
        "h": 1,
        "config": {
            "metric": "conversion_rate",
            "dimension": "none",
            "compare_period": true
        }
    },
    {
        "id": "slicer-campana",
        "type": "slicer",
        "title": "Filtrar por campaña",
        "w": 1,
        "h": 1,
        "config": {
            "dimension": "utm_campaign",
            "slicer_mode": "dropdown",
            "source": "leads"
        }
    },
    {
        "id": "bar-source",
        "type": "bar",
        "title": "Contactos por Source",
        "w": 2,
        "h": 2,
        "config": {
            "metric": "leads_count",
            "dimension": "utm_source",
            "limit": 10,
            "sort": "desc",
            "color": "#06b6d4"
        }
    },
    {
        "id": "pie-medium",
        "type": "pie",
        "title": "Reparto por Medium",
        "w": 2,
        "h": 2,
        "config": {
            "metric": "leads_count",
            "dimension": "utm_medium",
            "limit": 8,
            "sort": "desc"
        }
    },
    {
        "id": "h-embudo",
        "type": "heading",
        "title": "Del anuncio al cliente",
        "w": 4,
        "h": 1,
        "config": {
            "heading_level": 2
        }
    },
    {
        "id": "funnel-1",
        "type": "funnel",
        "title": "Embudo de conversión",
        "w": 2,
        "h": 3,
        "config": {
            "metrics": [
                "impressions",
                "clicks",
                "leads_count",
                "sales_count"
            ]
        }
    },
    {
        "id": "tbl-source",
        "type": "table",
        "title": "Rendimiento por Source",
        "w": 2,
        "h": 3,
        "config": {
            "metric": "leads_count,sales_count,conversion_rate",
            "dimension": "utm_source",
            "limit": 15,
            "sort": "desc",
            "show_totals": true
        }
    }
]'::jsonb,
    '{}'::jsonb,
    true,
    NULL,
    NULL
),
(
    'Cierre de mes',
    'Informe para enviar al cliente: resumen en lenguaje simple, comparación con el período anterior y detalle por campaña.',
    '[
    {
        "id": "h-cierre",
        "type": "heading",
        "title": "Cierre del período",
        "w": 4,
        "h": 1,
        "config": {
            "heading_level": 1,
            "accent": "#f59e0b"
        }
    },
    {
        "id": "sum-1",
        "type": "summary",
        "title": "Resumen",
        "w": 4,
        "h": 1,
        "config": {}
    },
    {
        "id": "kpi-spend",
        "type": "scorecard",
        "title": "Inversión",
        "w": 1,
        "h": 1,
        "config": {
            "metric": "spend",
            "dimension": "none",
            "compare_period": true
        }
    },
    {
        "id": "kpi-leads",
        "type": "scorecard",
        "title": "Contactos",
        "w": 1,
        "h": 1,
        "config": {
            "metric": "leads_count",
            "dimension": "none",
            "compare_period": true
        }
    },
    {
        "id": "kpi-cpl",
        "type": "scorecard",
        "title": "Costo por contacto",
        "w": 1,
        "h": 1,
        "config": {
            "metric": "cpl",
            "dimension": "none",
            "compare_period": true
        }
    },
    {
        "id": "kpi-roas",
        "type": "scorecard",
        "title": "Retorno (ROAS)",
        "w": 1,
        "h": 1,
        "config": {
            "metric": "roas",
            "dimension": "none",
            "compare_period": true
        }
    },
    {
        "id": "h-evolucion",
        "type": "heading",
        "title": "Cómo evolucionó el mes",
        "w": 4,
        "h": 1,
        "config": {
            "heading_level": 2
        }
    },
    {
        "id": "line-mes",
        "type": "line",
        "title": "Contactos por día",
        "w": 4,
        "h": 2,
        "config": {
            "metric": "leads_count",
            "dimension": "date",
            "date_grouping": "day",
            "color": "#f59e0b"
        }
    },
    {
        "id": "h-detalle",
        "type": "heading",
        "title": "Detalle por campaña",
        "w": 4,
        "h": 1,
        "config": {
            "heading_level": 2
        }
    },
    {
        "id": "tbl-cierre",
        "type": "table",
        "title": "Campañas del período",
        "w": 4,
        "h": 2,
        "config": {
            "metric": "spend,leads_count,cpl,sales_count,revenue,roas",
            "dimension": "utm_campaign",
            "limit": 25,
            "sort": "desc",
            "show_totals": true
        }
    },
    {
        "id": "nota-final",
        "type": "text",
        "title": "Notas del equipo",
        "w": 4,
        "h": 1,
        "config": {
            "text": "Escribe aquí el comentario que acompaña al informe: qué se probó este mes, qué funcionó y qué sigue."
        }
    }
]'::jsonb,
    '{}'::jsonb,
    true,
    NULL,
    NULL
)
ON CONFLICT (nombre) WHERE (is_template IS TRUE AND created_by IS NULL)
DO UPDATE SET
    descripcion = EXCLUDED.descripcion,
    layout      = EXCLUDED.layout,
    filters     = EXCLUDED.filters;
