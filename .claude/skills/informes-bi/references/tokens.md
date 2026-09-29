<!-- Generado por `npm run skill:informes` desde src/lib/agent/guias/informes.ts. No lo edites a mano. -->

# Ids de métricas y dimensiones

Todos salen de `list_report_fields`. La gramática, para reconocerlos:

- **Métricas fijas**: `spend`, `leads_count`, `cpl`, `roas`, `impressions`, `clicks`, `ctr`, `cpm`, `sales_count`, `revenue`, `hm_neto`, `hm_roas`… Van tal cual en `metric` y en fórmulas.
- **Dimensiones fijas**: `none` (total), `date`, `utm_campaign` (campaña real, cruza con el gasto), `utm_content` (anuncio), `utm_term` (conjunto), `utm_source`, `utm_medium`, `ip_country`, `form_name`, `platform`…
- **Pregunta de formulario** (dimensión): `leadfield:<pregunta>`.
- **Una respuesta** (métrica: leads que la eligieron): `leadans:<pregunta>:<respuesta>`; en fórmulas, `lf__<pregunta>__<respuesta>`. `leadans:<pregunta>:sin_respuesta` cuenta a los que no contestaron.
- **Segmento** (métrica): `leadseg:<clave>`; en fórmulas, `lseg__<clave>`.
- **Google Sheets**: `sheetdim:<clave>` (dimensión), `sheetagg:<agregación>:<clave>` y `sheetview:<clave>` (métricas); en fórmulas `sf__<clave>` y `sv__<clave>`.
- **Columnas offline**: `offfield:<tipo>:<clave>`; en fórmulas `off__<clave>`.
- **Eventos clave de GA4**: `ga4ev:<evento>` (p. ej. `ga4ev:purchase`; la lista sale de `list_report_fields` con `fuente: "ga4"`); en fórmulas, `ga4ev__<evento>` (coste por evento: `spend / ga4ev__<evento>`).
- **Conversiones personalizadas de Meta**: `metacc:<clave>`; en fórmulas, `mcc__<clave>` (coste por conversión: `spend / mcc__<clave>`). Las que el cliente marcó como resultado se suman en `resultados_custom`, y su coste es `coste_por_resultado_custom`.

**Fórmulas** (`config.formula` o campos calculados): `+ - * /` y paréntesis sobre ids de métricas fijas y alias (`lf__`, `lseg__`, `sf__`, `sv__`, `off__`, `mcc__`, `ga4ev__`). Un campo calculado NO puede usarse dentro de otra fórmula. Ejemplo: `spend / lf__rango_de_ingresos__2m_3m`.

## Qué se puede desglosar por qué

Un widget que desglosa una métrica por una dimensión que no la reparte mostraría 0 siempre; las herramientas lo rechazan. Las reglas:

- **Gasto, impresiones, clics, CTR, CPL, ROAS** (vienen de Meta/TikTok): por `date` y por campaña, anuncio o conjunto (`utm_campaign`, `utm_content`, `utm_term`, `ad`, `adset`). NO por `utm_source`, país, formulario ni pregunta de lead.
- **Leads, ventas, revenue, Hotmart neto**: por cualquier dimensión.
- **GA4 del sitio (`ga_sessions`, `ga_bounce_rate`, `ga_avg_session_duration`) y columnas offline**: solo por `date` (o total).
- **GA4 por campaña (`ga4_sesiones`, `ga4_eventos_clave`, `ga4_tasa_rebote`, `ga4_tasa_sesion_lead`, `ga4ev:`…)**: por `date`, campaña (`utm_campaign`, `utm_id`), `utm_source` y `utm_medium`. NO por anuncio, conjunto, país ni pregunta de lead. `ga4_coste_sesion`, `ga4_coste_evento_clave` y `ga4_roas` usan el gasto: solo por `date` y campaña. La suma por campaña puede no coincidir con `ga_sessions` (umbrales de privacidad de GA4): no mezcles las dos en un mismo total.
- **Por página de entrada (`dimension: "landing"`)**: cruzan los leads (su `page_url`) y las métricas de sesión de GA4 (`ga4_sesiones`, `ga4_tasa_rebote`, `ga4_tasa_sesion_lead`, `ga4_visitantes`…). El gasto, el CPL, las ventas, Hotmart y los `ga4ev:` salen «—». También se puede filtrar por `landing`.
- **Vistas por página**: `ga4_vistas` solo por `date` o por `dimension: "ga4_pagina"` (la página vista), sin filtros. `ga4_pagina` no sirve para ninguna otra métrica.
- **`ga4_visitantes`** es la suma de las personas de cada día: quien vuelve otro día cuenta dos veces y la fila Total sale «—». No la sumes con otras.
- **Conversiones de Meta (`metacc:`, `resultados_custom`)**: igual que el gasto: por `date` y por campaña, anuncio o conjunto.
- **MRR y métricas de suscripción**: solo total (`dimension: "none"`).
- **Filtrar por una pregunta de lead anula el gasto** (el gasto no se puede atribuir a una respuesta). Para medir el coste por respuesta usa una fórmula: `spend / lf__<pregunta>__<respuesta>`.
- **`dimension2`** solo funciona en barras, líneas, áreas o combo con una métrica que cuente leads o ventas.
