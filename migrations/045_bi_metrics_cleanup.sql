-- migrations/045_bi_metrics_cleanup.sql
-- Limpieza del catálogo de métricas del BI tras la auditoría de informes.
--
-- 1) `leads_total` ("Leads (todos los canales)") era un DUPLICADO EXACTO de
--    `leads_count`: ambos devolvían el mismo conteo de-duplicado de lead_events,
--    que ya abarca todos los canales (formularios web + Meta Lead Ads). Tener las
--    dos en el dropdown solo confundía: quien elegía "todos los canales" esperaba
--    un número mayor y obtenía el mismo. Se retira del catálogo y se reescriben
--    los layouts que la usaban.
--
--    El motor sigue respondiendo a `leads_total` (alias de compatibilidad en
--    bi-query.ts) por si queda algún layout sin migrar.

-- Paso 1: reemplazar el token de métrica en layouts y campos calculados.
UPDATE public.bi_reports
SET layout = replace(layout::text, '"leads_total"', '"leads_count"')::jsonb
WHERE layout::text LIKE '%leads_total%';

UPDATE public.bi_reports
SET layout = replace(layout::text, '"metric":"leads_total"', '"metric":"leads_count"')::jsonb
WHERE layout::text LIKE '%leads_total%';

-- Paso 2: las tablas multi-métrica guardan las columnas como CSV en una sola
-- cadena ("spend,leads_total"), así que el replace anterior no las alcanza.
UPDATE public.bi_reports
SET layout = replace(layout::text, 'leads_total', 'leads_count')::jsonb
WHERE layout::text LIKE '%leads_total%';

UPDATE public.bi_reports
SET calculated_fields = replace(calculated_fields::text, 'leads_total', 'leads_count')::jsonb
WHERE calculated_fields::text LIKE '%leads_total%';

-- Paso 3: dedup de columnas repetidas que pudo dejar el paso anterior
-- (una tabla con "leads_count,leads_total" quedaría como "leads_count,leads_count").
UPDATE public.bi_reports
SET layout = replace(layout::text, 'leads_count,leads_count', 'leads_count')::jsonb
WHERE layout::text LIKE '%leads_count,leads_count%';

-- 2) `ventas_cerradas` sigue en el catálogo, pero el BI ya NO la lee de la columna
--    `metricas_diarias.ventas_cerradas` (que el worker nunca escribe → siempre 0):
--    ahora sale de `metricas_diarias.metricas_manuales->>'VENTAS_CERRADAS'`, donde
--    el equipo la carga desde el dashboard. Es un cambio de código (bi-query.ts),
--    sin DDL. La columna se deja en su sitio: la leen /api/v1/metrics y el MCP.

COMMENT ON COLUMN public.metricas_diarias.ventas_cerradas IS
    'OBSOLETA para el BI: el worker no la escribe. El valor real de ventas cerradas se carga a mano en metricas_manuales->>''VENTAS_CERRADAS'', que es de donde lo lee el módulo de informes.';
