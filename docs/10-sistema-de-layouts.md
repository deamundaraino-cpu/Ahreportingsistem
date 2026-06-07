# 10 · Sistema de layouts y dashboards

El sistema de layouts define **qué se muestra y cómo** en cada dashboard, sin escribir código. Los tipos están en `src/lib/layout-types.ts`.

## Modelo conceptual

```
cliente
 └── cliente_tabs[]            (pestañas del dashboard)
       ├── layout global       (layouts_reporte) o
       ├── layout custom       (clientes_layouts)
       ├── hotmart_funnel      (clasificación de ventas del tab)
       ├── ranking_tables[]    (tablas top campañas/anuncios)
       └── filtros de campaña  (qué campañas alimentan el tab)
```

- **`layouts_reporte`**: plantillas globales reutilizables entre clientes.
- **`clientes_layouts`**: layout personalizado para un cliente concreto (override).
- **`cliente_tabs`**: cada pestaña referencia un layout (global o custom) y puede tener su propio filtro de campañas, embudo y rankings.

## Anatomía de un layout (`ReportLayout`)

Un layout agrupa bloques de distintos tipos, más metadatos:

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `columnas` | `ColDef[]` | Columnas de la tabla de métricas |
| `tarjetas` | `CardDef[]` | Tarjetas KPI |
| `graficos` | `ChartDef[]` | Gráficos |
| `text_blocks` | `TextBlockDef[]` | Bloques de texto enriquecido |
| `ranking_tables` | `RankingTableDef[]` | Tablas de ranking |
| `custom_metrics` | `MetricDef[]` | Métricas personalizadas (macros del usuario) |
| `blocks_order` | `string[]` | Orden de los bloques en pantalla |
| `source_mapping` | `Record<string,string>` | Mapeo de alias semánticos → campos |
| `attribution_strategy` | `'hybrid' \| 'full_meta' \| 'full_hotmart' \| 'custom'` | Estrategia de atribución de ventas |

### Columnas y tarjetas (`ColDef` / `CardDef`)

```ts
{
  id: string
  label: string
  formula: string                 // evaluada por el motor de fórmulas
  prefix?, suffix?, decimals?     // formato ("$", "%", 2)
  align?: 'left' | 'right'
  highlight?, hidden?, isManual?
  campaignFilter?: CampaignFilterSpec
  formFilter?: FormFilterSpec
  color?: CardColor               // solo CardDef: default | emerald | red | blue | amber
}
```

### Gráficos (`ChartDef`)

```ts
{
  id, title, type: ChartType      // area, stacked_area, bar, stacked_bar, line,
                                  // donut, pie, composed, radial, scatter, funnel
  categoryColumns: string[]       // p.ej. ["fecha"] o ["week"]
  valueFormulas: string[]         // una fórmula por serie
  colors?, height?
  campaignFilter?, formFilter?, account_id?
  yAxes?: ('left'|'right')[]      // doble eje
  types?: ('line'|'bar'|'area'|'')[]   // tipo por serie (gráfico combinado)
  strokeWidths?, showDataLabels?
  periodicity?: 'day'|'week'|'month'|'year'
  units?: ('number'|'currency'|'percent')[]
}
```
Renderizados con **Recharts** en `MetricCharts.tsx`.

### Tablas de ranking (`RankingTableDef`)
Muestran top N de campañas/anuncios/conjuntos. La agregación la hace `ranking-aggregation.ts` (`aggregateRankingRows`), sobre dimensiones:
- Meta: `campaigns`, `ads`, `adsets`.
- TikTok: `tiktok_campaigns`, `tiktok_ads`, `tiktok_adgroups`.

Componente: `RankingTableBlock.tsx`.

### Bloques de texto (`TextBlockDef`)
Texto enriquecido (h1–h3, párrafos, colores, tipografías, bordes) para separadores y anotaciones.

## Filtros de campaña (`CampaignFilterSpec`)

Cada bloque puede filtrar qué campañas lo alimentan. Lógica en `campaign-filter.ts`.

```ts
{
  type: 'group' | 'keyword',
  operator?: CampaignFilterOperator,
  value: string | string[]
}
```

Operadores (`CampaignFilterOperator`): `includes`, `excludes`, `exact`, `not_exact`, `starts_with`, `ends_with`, `any_of`, `none_of`.

- `enrichMetaRow(row, filter, campaignGroups)` recorre `meta_campaigns`, selecciona las que pasan el filtro y **suma** sus métricas (spend, impressions, clicks, link_clicks, reach, frequency + todas las conversiones estándar). Además expande `custom_conversions` a campos `meta_custom_*` y mezcla métricas manuales.
- Los grupos de campañas (`campaign_groups` + `campaign_group_mappings`) permiten agrupar por ID exacto o patrón `%`/`_`.

## Filtros de formulario (`FormFilterSpec`)

Para campañas de leads, `form-filter.ts` (`enrichFormRow`) filtra `meta_forms` por `form_id` o `form_name` y agrega sus métricas.

## Embudo Hotmart por tab

Cada tab define en `hotmart_funnel` los patrones de nombre que clasifican las ventas:
- `principal_names`, `bump_names`, `upsell_names` (soportan `%`/`_`).
- `payment_page_url`, `upsell_page_url`.

El worker usa esos patrones para llenar `hotmart_funnel_data.by_tab[tabId]`, que el `DashboardClient` inyecta como campos `funnel_*` en cada fila para que el motor de fórmulas calcule ROAS, ROI, % de conversión, etc. del embudo. Ver [doc 09](./09-motor-de-formulas.md).

## Desglose por país

`country-parser.ts` extrae el país de cada campaña (por prioridad: targeting regions → notación `[PAIS]` → sufijo `-Pais`) y `aggregateByCountry()` agrega métricas por país con CPL/CPR y top anuncios. Componente: `CountryBreakdown.tsx`.

## Reordenamiento (drag & drop)

El orden de tabs/bloques se gestiona con `@dnd-kit` mediante el hook `src/lib/hooks/useLayoutReorder.ts`:
- Actualiza la UI de forma **optimista** y revierte si falla.
- Persiste vía `POST /api/layouts/reorder` con `{ clienteId, tabOrder: [{ id, position }] }`.

## Constructor de layouts (Layout Builder)

`/admin/layouts` (`LayoutBuilderClient.tsx`) permite crear/editar layouts: arrastrar tarjetas, columnas, gráficos y bloques de texto; elegir fórmulas/alias y filtros. El catálogo de alias semánticos se lee de `SEMANTIC_ALIASES` para poblar los desplegables.

## Configuración desde el dashboard

Dentro del dashboard del cliente existen modales para editar sin salir:
- `LayoutConfigModal` — configurar el layout del tab.
- `TabConfigModal` — configurar el tab (nombre, filtro, embudo, rankings).
- `QuickEditModal` — edición rápida de bloques.
- `TabArchiveView` — ver/gestionar tabs archivados (`archived`).

## Enlaces públicos y espejo

- `/report/[clientId]` — reporte público por ID.
- `/p/[token]` — dashboard espejo por `public_token` (de cliente o tab). El tipo `tab_mirror` muestra solo las pestañas seleccionadas.
- Se generan desde los botones `CopyLinkButton` / `PublicLinkButton`.

Los datos del espejo los provee `getMirrorDashboardData(token, from, to)`.
