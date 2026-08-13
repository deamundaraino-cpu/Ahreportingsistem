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
| `lead_answer_blocks` | `LeadAnswerBlockDef[]` | Desglose de leads por respuesta de formulario |
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

## Filtro de Sheet (`SheetFilterSpec`)

Segmenta las conversiones offline que alimentan un bloque. Lógica en `offline-filter.ts`.

```ts
{
  field: string,                // 'tipo' | 'fuente' | 'notas' | 'sheet_<columna>'
  operator: SheetFilterOperator,
  value: string | string[]
}
```

Operadores: `equals`, `not_equals`, `includes`, `excludes`, `any_of`, `none_of`, `greater_than`, `less_than`, `greater_equal`, `less_equal`.

`enrichOfflineRow(row, filter)` se queda con las filas de `row.offline_rows` que pasan el filtro y **recalcula** desde ellas `offline_leads`, `offline_ventas`, `offline_revenue`, `offline_total` y las columnas numéricas `sheet_<clave>`. Sirve para tener dos bloques con la misma fórmula pero distinto segmento del Sheet.

**Solo afecta a esas variables.** Sobre una fórmula de `meta_*`, `sf_*` o `sv_*` el filtro no cambia nada: esos valores llegan ya agregados desde `merge-metrics.ts` y no se recomponen por fila.

Dónde aplica:

| Bloque | Filtro de Sheet |
| --- | --- |
| Columnas de tabla | Sí |
| Tarjetas (valor actual y comparativo) | Sí |
| Gráficos temporales (sin `dimension`) | Sí |
| Gráficos con `dimension` | **No** — el selector no se ofrece |
| Tablas de ranking | **No** — sin campo en el tipo |

Los dos últimos agregan por campaña/anuncio con `aggregateRankingRows`, que construye sus filas desde `meta_campaigns` / `meta_ads` / `meta_adsets`. El dato offline es por día y no tiene desglose por campaña, así que ahí el filtro no tendría a qué aplicarse.

El comparativo de las tarjetas necesita las filas offline del periodo anterior. `getDashboardData` solo las carga si algún bloque del layout, de sus pestañas o de las plantillas que estas referencian declara un `sheetFilter` (`layoutUsaSheetFilter`); en el archivo de pestañas la decisión equivalente la toma `TabArchiveView` antes de llamar a `getArchiveMetrics`. Traerlas siempre serían decenas de miles de filas para los clientes que no usan el filtro.

## Embudo Hotmart por tab

Cada tab define en `hotmart_funnel` los patrones de nombre que clasifican las ventas:
- `principal_names`, `bump_names`, `upsell_names` (soportan `%`/`_`).
- `payment_page_url`, `upsell_page_url`.

El worker usa esos patrones para llenar `hotmart_funnel_data.by_tab[tabId]`, que el `DashboardClient` inyecta como campos `funnel_*` en cada fila para que el motor de fórmulas calcule ROAS, ROI, % de conversión, etc. del embudo. Ver [doc 09](./09-motor-de-formulas.md).

## Desglose por respuesta de formulario (`LeadAnswerBlockDef`)

Responde **«cuántos leads contestaron A, cuántos B y cuántos C»** en una pregunta
del formulario — no «cuántos respondieron». Es la forma de saber *qué tipo* de
lead trae cada campaña sin salir del dashboard.

Se agrega como cualquier otro bloque (**Agregar → Respuestas de formulario**),
se arrastra, se duplica y viaja al enlace público. Respeta el filtro de campañas
**y** el recorte de fechas de la pestaña.

### De dónde sale la pregunta

| `origen` | Qué usa | Cuándo |
|---|---|---|
| `catalogo` | `report_utm.lead_campos` vía `clave` | El analista ya la configuró: nombre propio, respuestas equivalentes agrupadas y ordenadas |
| `auto` | `clavesOrigen` inline, valores crudos | Estreno sin configurar nada |

Los dos producen un `LeadCampoDef` y a partir de ahí el camino es **uno solo**.
El picker ofrece **«Guardar en el catálogo»** (`promoverCampoLead`), que es la vía
para pasar de `auto` a `catalogo` sin obligar a configurar antes de ver nada. Un
campo del catálogo es además lo **único** que puede unir la misma pregunta
llegada con dos claves distintas (Meta y web) en un solo desglose.

### Cómo se calculan las cifras

1. `report_utm.bi_respuestas_por_dia` (migración 071) pliega los leads a
   `(día Colombia × valor × tupla UTM)`. Las claves se comparan por
   `report_utm.norm_clave` en los dos lados — espejo de `indexarRawFields`.
2. [`lead-answers-db.ts`](../src/lib/report-utm/lead-answers-db.ts) aplica el
   catálogo (`bucketDeValor`), resuelve la campaña **una vez por tupla UTM** con
   la cascada de `campaign-resolver`, y colapsa a `(día × campaña × bucket)`
   codificado por diccionario. Solo eso viaja al navegador.
3. [`lead-answer-aggregation.ts`](../src/lib/dashboard/lead-answer-aggregation.ts)
   aplica filtro de pestaña → filtro del bloque → recorte de fechas → Top-N.

El dato viaja como campo **hermano** de `metrics`, no dentro de sus filas:
`mergeMetricasDelRango` no se toca a propósito (ver abajo).

### Total diario y métricas en cualquier widget

Además del bloque, Report-UTM aporta métricas que el trafficker puede usar en
**tarjetas, gráficas, columnas de tabla y tablas de ranking**:

| Métrica | Qué es |
|---|---|
| `utm_leads` | Contactos del día según `lead_events` (web + Meta Lead Ads unificados) |
| `lf__<campo>__<respuesta>` | Leads del día que contestaron esa respuesta |
| `lf__<campo>__sin_respuesta` | Leads del día que no contestaron esa pregunta |

Por construcción, **las respuestas más `sin_respuesta` suman `utm_leads`**: es lo
que permite leer «hoy 40, de los cuales 15 A, 5 B, 3 C y 17 sin responder» sin
preguntarse dónde está el resto.

> `utm_leads` **no se suma con `meta_leads`**. Miden lo mismo desde fuentes
> distintas —el contacto real del formulario frente a lo que reporta el píxel— y
> un lead puede estar en las dos.

### Dónde funcionan, exactamente

| Sitio | Estado |
|---|---|
| Tarjetas superiores (valor, delta, sparkline, progreso) | ✅ |
| Columnas de tabla (resumen, celda diaria, fila semanal) | ✅ |
| Gráficas por fecha, con o sin filtro propio | ✅ |
| Tablas de ranking y gráficas **por dimensión Campaña** | ✅ |
| Tablas de ranking y gráficas por **Anuncio / Conjunto** | `n/a` con aviso |
| Archivo de pestañas | `—` |

**Anuncio y conjunto no aplican, y no es un hueco:** el cubo resuelve cada lead
hasta su **campaña** porque un formulario no sabe qué anuncio trajo al visitante.
La celda dice `n/a` y la serie se omite del gráfico con una nota — un 0 afirmaría
que no hubo leads, que es falso.

En el **archivo** las claves no existen (no se carga el cubo para rangos de
años), así que las fórmulas dan `—`. Es deliberado: un 0 diría «no hubo
contactos» en vez de «no se consultó».

### Cómo se recortan por campaña

Cada fila lleva el cubo **por referencia** (`__leadAnswers`, no numérica: el motor
de fórmulas la ignora igual que ignora `meta_campaigns`), y `applyCompoundFilter`
re-deriva las claves cuando un bloque tiene su propio filtro.

Eso importa: `enrichMetaRow` solo recalcula las claves `meta_*`. Sin la
re-derivación, una tarjeta `meta_spend / utm_leads` **con filtro propio** dividía
un gasto ya recortado entre los contactos de toda la pestaña y devolvía un CPL
hundido, sin ningún aviso. Al recortarse numerador y denominador por la misma
campaña, `meta_spend / lf__x` sí significa algo: **el costo por lead de ese
segmento**.

Coste: el total diario es la consulta cara (lee todos los leads del rango), así
que solo se pide si hay un bloque de respuestas **o** alguna fórmula menciona
`utm_leads`/`lf__` — lo decide `layoutUsaRespuestasLead`, mismo patrón que
`layoutUsaSheetFilter`.

### Lo que este bloque NO hace, y por qué

**El bloque no muestra columnas de gasto ni CPL.** El gasto vive en
`metricas_diarias`, agregado por día y campaña: una fila de gasto no sabe qué
respondió cada lead, porque una respuesta de formulario no existe a nivel de
anuncio. **Repartir** el gasto entre las respuestas daría un CPL inventado con
aspecto de dato medido, y eso el sistema no lo hace — misma decisión que los
filtros por país, formulario y campo de lead en el BI
([doc 17](./17-campos-de-lead.md), [doc 18](./18-fuentes-y-cruces.md) parte 5).

**Lo que sí se puede pedir** —y es distinto— es `meta_spend / lf__<campo>__<resp>`
en una tarjeta o una columna: el gasto total del ámbito filtrado dividido por los
leads de ese tipo. No reparte nada; responde «cuánto me cuesta conseguir un lead
de este tipo», que es justo lo que se optimiza. Funciona porque el numerador y el
denominador quedan recortados por la misma campaña.

### Qué declara cuando no puede medir

Nunca un cero mudo:
- Cliente sin enlazar a report_utm → lo dice, con la ruta para arreglarlo.
- Cliente cuyos formularios solo piden nombre y correo → lo dice, con cuántos
  leads se revisaron (es el caso de Eduversio, el cliente con más leads).
- Leads que no cruzaron campaña → se cuentan aparte y se declaran al pie cuando
  un filtro los deja fuera.
- Cola recortada por Top-N → «Otras respuestas (k)», o los leads omitidos
  declarados si se desactiva la agrupación.
- Consulta truncada → aviso ámbar de datos parciales.

Comprobaciones: `verify-lead-answers.ts` (puro) y `verify-lead-answers-db.ts`
(datos, incluye la paridad valor a valor entre la RPC y `bucketDeLead`).

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
