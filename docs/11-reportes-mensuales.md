# 11 · Reportes mensuales

Sistema para generar reportes mensuales por cliente a partir de plantillas, revisarlos y publicarlos como página pública (con opción a PDF).

## Componentes

| Pieza | Ubicación |
|-------|-----------|
| Tablas | `report_templates`, `monthly_reports` (migración 004) |
| Gestión (admin) | `/admin/reports`, `/admin/reports/[id]` |
| Vista pública por slug | `/report/monthly/[slug]` |

> **Retirado:** la pestaña «📊 Reporte Mensual» del dashboard de cliente
> (`MonthlyReportTab.tsx`), su API `GET/POST /api/reports/monthly` y su vista pública
> `/report/[clientId]/monthly/[year]/[month]` se eliminaron: quedan suplidas por los informes
> del BI Builder en `/report-utm/informes`, accesibles desde el botón «Ir a los Informes» de la
> cabecera del dashboard. La tabla `reportes_mensuales` (notas ejecutivas de aquella pestaña)
> quedó huérfana y sin código que la use; no se borró por precaución. El módulo admin descrito
> aquí es independiente y sigue vigente.

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

