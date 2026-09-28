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
- **Conversiones personalizadas de Meta**: `metacc:<clave>`.

**Fórmulas** (`config.formula` o campos calculados): `+ - * /` y paréntesis sobre ids de métricas fijas y alias (`lf__`, `lseg__`, `sf__`, `sv__`, `off__`). Un campo calculado NO puede usarse dentro de otra fórmula. Ejemplo: `spend / lf__rango_de_ingresos__2m_3m`.

## Qué se puede desglosar por qué

Un widget que desglosa una métrica por una dimensión que no la reparte mostraría 0 siempre; las herramientas lo rechazan. Las reglas:

- **Gasto, impresiones, clics, CTR, CPL, ROAS** (vienen de Meta/TikTok): por `date` y por campaña, anuncio o conjunto (`utm_campaign`, `utm_content`, `utm_term`, `ad`, `adset`). NO por `utm_source`, país, formulario ni pregunta de lead.
- **Leads, ventas, revenue, Hotmart neto**: por cualquier dimensión.
- **GA4 y columnas offline**: solo por `date` (o total).
- **Conversiones de Meta (`metacc:`)**: por `date` o por campaña.
- **MRR y métricas de suscripción**: solo total (`dimension: "none"`).
- **Filtrar por una pregunta de lead anula el gasto** (el gasto no se puede atribuir a una respuesta). Para medir el coste por respuesta usa una fórmula: `spend / lf__<pregunta>__<respuesta>`.
- **`dimension2`** solo funciona en barras, líneas, áreas o combo con una métrica que cuente leads o ventas.
