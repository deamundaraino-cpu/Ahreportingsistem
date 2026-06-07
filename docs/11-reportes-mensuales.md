# 11 · Reportes mensuales

Sistema para generar reportes mensuales por cliente a partir de plantillas, revisarlos y publicarlos como página pública (con opción a PDF).

## Componentes

| Pieza | Ubicación |
|-------|-----------|
| Tablas | `report_templates`, `monthly_reports` (migración 004) |
| Gestión (admin) | `/admin/reports`, `/admin/reports/[id]` |
| API de datos | `GET/POST /api/reports/monthly` |
| Vista pública por cliente | `/report/[clientId]/monthly/[year]/[month]` |
| Vista pública por slug | `/report/monthly/[slug]` |
| Tab en dashboard | `MonthlyReportTab.tsx` |

## Plantillas (`report_templates`)

Definen qué tarjetas, columnas, gráficos y `source_mapping` lleva el reporte. Hay tres tipos (`tipo`): `captacion`, `infoproducto`, `hibrido`. La migración 004 inserta tres plantillas seed:

1. **Captación de Leads** — Gasto, Leads, CPL, Impresiones, CTR, Visitas (GA4 → visitas, Meta leads → conversiones).
2. **Infoproducto Hotmart** — Gasto Meta, Ventas, ROAS, Leads, Pagos Iniciados, Compras.
3. **Híbrido GA4 + Meta** — Sesiones GA4, Gasto Meta, Leads, CPL, CTR, Tasa de Rebote.

## Ciclo de vida (`monthly_reports.estado`)

```
borrador → revision → aprobado → publicado
```

- `periodo`: `'YYYY-MM'` (único por cliente).
- `campaigns_discovered`: campañas con gasto > 0 detectadas en el periodo.
- `campaigns_included`: subconjunto elegido para el reporte.
- `kpis_snapshot`: KPIs congelados al publicar.
- `public_slug`: slug para la URL pública.
- `pdf_url`: PDF generado (si aplica).
- `created_by`, `approved_by`.

## Flujo de trabajo (admin)

1. En `/admin/reports`, seleccionar cliente y periodo.
2. **Descubrir campañas** (`discoverCampaigns`) escanea `meta_campaigns` en `metricas_diarias` del periodo.
3. **Crear reporte** (`createMonthlyReport`) a partir de una plantilla.
4. Editar en `/admin/reports/[id]`: elegir campañas incluidas, notas, plantilla (`updateMonthlyReport`).
5. Avanzar el estado hasta `publicado` para exponerlo públicamente.

Server actions en `(app)/admin/reports/_actions.ts`: `getMonthlyReports`, `getMonthlyReport`, `getReportTemplates`, `discoverCampaigns`, `createMonthlyReport`, `updateMonthlyReport`.

## API de datos: `GET /api/reports/monthly`

Params: `clientId`, `year`, `month`. Agrega los datos del mes y devuelve:

```jsonc
{
  "client":  { "name", "logo_url", "currency", "roas_target" },
  "summary": { "spend","reach","impressions","clicks","link_clicks",
               "results","leads","purchases","landing_views",
               "cpa","roas","ctr","cpm" },
  "daily":   [{ "date","spend","results" }],
  "campaigns": [{
    "name","campaign_id","spend","impressions","clicks","link_clicks",
    "reach","frequency","cpc","cpm","ctr","leads","purchases",
    "initiates_checkout","landing_page_views","results",
    "thumbnail_url","cpa","roas","roasStatus"
  }],
  "spend_distribution": [{ "name","value","pct" }],
  "audience": {
    "by_age":    [{ "group","spend_pct","results_pct" }],
    "by_gender": [{ "gender","spend_pct","results_pct" }]
  },
  "creatives": { "top": [...], "bottom": [...] },
  "previous_month": { "spend","results","cpa","ctr","reach" },
  "notes": "…"
}
```

`POST /api/reports/monthly` con `{ clientId, year, month, notas }` actualiza las notas ejecutivas.

## Vista pública (`/report/[clientId]/monthly/[year]/[month]`)

Componente cliente que consume la API y renderiza con Recharts. Secciones:

1. Encabezado (logo, periodo, acciones).
2. Tarjetas KPI (spend, results, CPA, CTR, reach, impressions, CPM, ROAS).
3. Evolución diaria (área: spend + results).
4. Tabla de campañas (ordenable).
5. Distribución de presupuesto (pie).
6. Audiencia (edad/género).
7. Creativos top/bottom.
8. Comparativa mes anterior.
9. Notas ejecutivas.
10. Pie con compartir / descargar PDF.

Está **optimizado para impresión** (CSS de print): se puede exportar a PDF con Ctrl+P o mediante `jspdf` + `html2canvas`. Estas rutas permiten ser embebidas (CSP `frame-ancestors *`).
