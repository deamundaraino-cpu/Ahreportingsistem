# 09 · Motor de fórmulas

Archivo: `src/lib/formula-engine.ts`. Es el **núcleo del producto**: convierte fórmulas de texto en números, evaluándolas sobre las filas de `metricas_diarias`. Permite que cada layout defina sus KPIs sin tocar código.

## ¿Por qué un motor propio?

La política de seguridad (CSP) prohíbe `eval` y `new Function`. Por eso el motor implementa un **parser aritmético de descenso recursivo** (`safeEvalArithmetic`) que solo entiende `+ - * / ( )` y números. Antes de evaluar, valida que la expresión sanitizada coincida con `/^[\d\s\+\-\*\/\.\(\)]+$/`.

## Tres niveles de nombres

Una fórmula puede mezclar tres tipos de identificadores, que se resuelven en cascada:

### 1. Campos (`FIELD_MAP`)
~85 campos crudos que existen (o se inyectan) en la fila de métricas. Categorías:
- **Meta — entrega**: `meta_spend`, `meta_impressions`, `meta_reach`, `meta_frequency`, `meta_clicks`, `meta_link_clicks`.
- **Meta — eventos de pixel**: `meta_leads`, `meta_purchases`, `meta_adds_to_cart`, `meta_initiates_checkout`, `meta_landing_page_views`, `meta_complete_registration`, `meta_view_content`, `meta_contact`, `meta_schedule`, `meta_results`, etc.
- **Meta — video**: `meta_video_views`, `meta_video_3s_views`, `meta_video_thruplay`.
- **Meta — engagement / mensajería**: `meta_post_engagement`, `meta_post_reactions`, `meta_messaging_conversations_started`, etc.
- **GA4**: `ga_sessions`, `ga_bounce_rate`, `ga_avg_session_duration`.
- **TikTok**: `tiktok_spend`, `tiktok_impressions`, `tiktok_clicks`, `tiktok_conversions`.
- **Hotmart**: `hotmart_pagos_iniciados`, `hotmart_clics_link`.
- **Ventas globales**: `ventas_principal/bump/upsell` (+ `_count`, `_bruto`), `ventas_cerradas`.
- **Funnel del tab activo** (inyectados por `DashboardClient` desde `hotmart_funnel_data.by_tab[tabId]`): `funnel_principal_neto`, `funnel_principal_count`, `funnel_principal_price`, `funnel_bump_neto`, `funnel_upsell_neto`, `funnel_upsell_visits`, `funnel_pagos_iniciados`, etc.
- **Leads (Google Sheets)**: `leads_totales`, `leads_calificados`, `leads_no_calificados`, `tasa_calificacion`.

### 2. Macros (`MACRO_MAP`)
Métricas derivadas que se definen como **fórmulas**, no como valores. Se expanden recursivamente antes de evaluar. Esto garantiza una **agregación correcta**: al sumar varios días no se promedian CPCs, sino que se divide el spend total entre los clics totales.

Ejemplos:
```
meta_cpc  = meta_spend / meta_clicks
meta_cpm  = (meta_spend / meta_impressions) * 1000
meta_ctr  = (meta_clicks / meta_impressions) * 100
meta_cpl  = meta_spend / meta_leads
meta_roas = (ventas_principal + ventas_bump + ventas_upsell) / meta_spend
tiktok_cpc = tiktok_spend / tiktok_clicks

funnel_facturacion_neta = funnel_principal_neto + funnel_bump_neto + funnel_upsell_neto
funnel_roas  = (funnel_principal_neto + funnel_bump_neto + funnel_upsell_neto) / meta_spend
funnel_roi   = ((funnel_…_neto sumados) - meta_spend) / meta_spend
funnel_costo_compra = meta_spend / funnel_principal_count
funnel_pct_pagos_compras = (funnel_principal_count / funnel_pagos_iniciados) * 100

total_facturacion_neta = ventas_principal + ventas_bump + ventas_upsell
total_roas = (ventas_principal + ventas_bump + ventas_upsell) / meta_spend
```

La expansión detecta **referencias circulares** y devuelve `'0'` para romper ciclos.

### 3. Alias semánticos (`SEMANTIC_ALIASES`)
Nombres de alto nivel (empiezan con `$`) que el usuario elige en el Layout Builder y que se mapean a un campo concreto según el `source_mapping` del layout. Permiten que un mismo layout funcione con distintas fuentes.

| Alias | Fuente por defecto | Alternativas |
|-------|--------------------|--------------|
| `$visitas` | `ga_sessions` | `meta_landing_page_views`, `meta_link_clicks` |
| `$pagos_iniciados` | `hotmart_pagos_iniciados` | `meta_initiates_checkout`, `meta_adds_to_cart` |
| `$conversiones` | `meta_purchases` | `meta_leads`, `meta_complete_registration` |
| `$facturacion_principal/bump/upsell` | `ventas_*` | — |
| `$funnel.*` | `funnel_*` | (se inyectan según la pestaña activa) |

## Resolución con fallback de plataforma

`resolveAliasesWithFallback(formula, mapping, availablePlatforms)` ajusta el alias si la plataforma necesaria no está configurada para el cliente:

- `$visitas` → `ga_sessions` si hay GA4; si no, cae a `meta_landing_page_views`.
- `$pagos_iniciados` → `hotmart_pagos_iniciados` si hay Hotmart; si no, `meta_initiates_checkout`.
- Los campos `ventas_*` (revenue de Hotmart) no tienen equivalente Meta: si no hay Hotmart, la fórmula devuelve `null` de forma controlada.

## Funciones principales

| Función | Propósito |
|---------|-----------|
| `evaluateFormula(formula, row, context?, sourceMapping?, availablePlatforms?, customMetrics?)` | Evalúa una fórmula sobre **una fila**. Devuelve `number` o `null` (división por cero, NaN, infinito o campo faltante). |
| `aggregateFormula(formula, rows[], …)` | Evalúa sobre **varias filas** sumando numeradores y denominadores por separado (agregación correcta de ratios). |
| `resolveAliases(formula, mapping?)` | Sustituye alias `$…` por campos (orden por longitud descendente para evitar colisiones de prefijos). |
| `resolveAliasesWithFallback(…)` | Igual, con fallback de plataforma. |
| `expandFormulaRecursive(formula, macroMap, path?)` | Expande macros y métricas custom con detección de ciclos. |
| `safeEvalArithmetic(input)` | Parser de descenso recursivo (sin `eval`). |
| `filterRowByTikTokAccount(row, accountId)` | Filtra métricas TikTok por `advertiser_id`. |
| `formatValue(value, { prefix, suffix, decimals })` | Formatea para mostrar (moneda, %, decimales). |

### Pipeline de `evaluateFormula`

```
fórmula  →  resolveAliases(+fallback)  →  expandir macros (recursivo)
         →  reemplazar campos por valores numéricos (row + context)
         →  validar regex de caracteres permitidos
         →  safeEvalArithmetic()  →  número | null
```

## Métricas custom

Un layout puede definir **métricas personalizadas** (`customMetrics`) que se comportan como macros adicionales: se inyectan en el mapa de expansión y pueden referenciarse desde otras fórmulas/columnas. Se gestionan en el Layout Builder.

## Ejemplos de fórmulas

```
meta_spend / meta_clicks                          # CPC
(meta_spend / meta_impressions) * 1000            # CPM
$pagos_iniciados                                  # alias → fuente configurada
$funnel.roas                                      # ROAS del embudo del tab activo
(funnel_principal_count / funnel_pagos_iniciados) * 100   # % pagos→compras
meta_spend / leads_calificados                    # CPL sobre leads calificados (Sheets)
```

## Módulos que se apoyan en el motor

- **`campaign-filter.ts`** — `enrichMetaRow()` agrega métricas de campañas que pasan un filtro (por grupo, keyword u operadores) y expande `custom_conversions` a campos `meta_custom_*` que las fórmulas pueden usar. Ver [doc 10](./10-sistema-de-layouts.md).
- **`form-filter.ts`** — `enrichFormRow()` agrega métricas de formularios Meta (`meta_forms`) por `form_id`/`form_name`.
- **`ranking-aggregation.ts`** — agrega filas para tablas de ranking (campañas/anuncios/conjuntos, Meta o TikTok).
- **`country-parser.ts`** — `aggregateByCountry()` agrupa campañas por país (extraído del nombre o de targeting) y calcula CPL/CPR.
