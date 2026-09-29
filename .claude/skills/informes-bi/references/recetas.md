<!-- Generado por `npm run skill:informes` desde src/lib/agent/guias/informes.ts. No lo edites a mano. -->

# Recetas

**Fila de KPIs** (cuatro scorecards de ancho 1):
```json
{"type":"scorecard","title":"Inversión","w":1,"config":{"metric":"spend","compare_period":true}}
{"type":"scorecard","title":"Leads","w":1,"config":{"metric":"leads_count","compare_period":true}}
{"type":"scorecard","title":"CPL","w":1,"config":{"metric":"cpl","compare_period":true}}
{"type":"scorecard","title":"ROAS Hotmart","w":1,"config":{"metric":"hm_roas","compare_period":true}}
```

**Evolución semanal**:
```json
{"type":"line","title":"Leads por semana","w":4,"config":{"metric":"leads_count","dimension":"date","date_grouping":"week"}}
```

**Tabla de campañas**:
```json
{"type":"table","title":"Campañas","w":4,"h":2,"config":{"metric":"spend,leads_count,cpl","dimension":"utm_campaign","limit":20,"show_totals":true}}
```

**CPL por respuesta de formulario** (con los tokens de `list_report_fields`):
1. `upsert_calculated_field` por respuesta: nombre «CPL 2M-3M», expresión `spend / lf__rango__2m_3m`, formato `currency`.
2. Barras de reparto: `{"type":"bar","config":{"metric":"leads_count","dimension":"leadfield:rango","limit":30}}`.
3. Tabla por campaña: `{"type":"table","config":{"metric":"spend,leads_count,leadans:rango:2m_3m,CPL 2M-3M","dimension":"utm_campaign"}}`.

**GA4 por campaña** (sesiones, coste por sesión y sesión → lead):
```json
{"type":"table","title":"Tráfico por campaña","w":4,"h":2,"config":{"metric":"spend,ga4_sesiones,ga4_coste_sesion,leads_count,ga4_tasa_sesion_lead","dimension":"utm_campaign","limit":20,"show_totals":true}}
```
Para que cruce exacto con el gasto, los anuncios de Meta deben llevar `utm_id={{campaign.id}}` en los parámetros de URL. Eventos clave frente a leads: `{"metric":"leads_count,ga4ev:generate_lead","dimension":"utm_campaign"}`.

**Landing por landing** (sesiones → leads por página de entrada):
```json
{"type":"table","title":"Páginas de entrada","w":4,"h":2,"config":{"metric":"ga4_sesiones,ga4_visitantes,leads_count,ga4_tasa_sesion_lead,ga4_tasa_rebote","dimension":"landing","limit":20}}
```
Vistas por página: `{"metric":"ga4_vistas","dimension":"ga4_pagina","limit":20}`.

**Embudo**: `{"type":"funnel","config":{"metrics":["impressions","clicks","leads_count","sales_count"]}}`. Valen como etapa los conteos y los segmentos o respuestas de lead.

**Agrupar en una sección**: crea la sección con `add_report_widget` (`{"type":"section","title":"Captación","config":{"columns":4}}`) y añade dentro con `seccion_id`, o pásala entera con `children`.
