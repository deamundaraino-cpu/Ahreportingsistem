-- ════════════════════════════════════════════════════════════════
-- Migration 072: total diario de contactos de Report-UTM
-- ════════════════════════════════════════════════════════════════
-- La migración 071 dejó el desglose por respuesta, pero solo cuenta los leads
-- QUE RESPONDIERON la pregunta. Falta el denominador: "hoy se registraron 40",
-- de los cuales 15 respondieron A, 5 B, 3 C y 17 D.
--
-- Sin este total, el bloque no puede cerrar la cuenta: los buckets suman 23 y
-- nadie sabe si los otros 17 no respondieron o si el sistema se los perdió. Con
-- él aparece `(sin respuesta)` y la suma cuadra siempre con el total del día.
--
-- ── Por qué NO sale de `metricas_diarias.meta_leads` ────────────────────
-- Son números distintos que miden lo mismo desde fuentes distintas y SE SOLAPAN
-- (ver el catálogo de la fuente `leads` en bi/sources/leads.ts, campo
-- `conflictsWith`). `meta_leads` es lo que reporta el píxel de Meta;
-- `lead_events` es el contacto real que entró por el formulario, web y Meta Lead
-- Ads unificados. Un lead puede estar en los dos, así que sumarlos infla y usar
-- uno como total del otro descuadra.
--
-- ── Por qué la tupla UTM y no solo el día ───────────────────────────────
-- Porque el dashboard filtra por campaña. Un total diario "plano" se colaría sin
-- filtrar en una pestaña de campaña —`enrichMetaRow` solo recalcula las claves
-- `meta_*`— y mostraría el número de TODO el cliente junto a un gasto que sí
-- está recortado. Devolviendo la tupla, Node resuelve la campaña con la misma
-- cascada de siempre y el total se puede recortar igual que el gasto.
--
-- Es la misma decisión y el mismo grano que la 071, sin la parte del JSONB: aquí
-- no hay que mirar `raw_fields`, así que es una consulta mucho más barata.
--
-- REVERSIBLE:
--   DROP FUNCTION IF EXISTS report_utm.bi_leads_por_dia(uuid,timestamptz,timestamptz,int);
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION report_utm.bi_leads_por_dia(
    p_cliente_id UUID,
    p_desde      TIMESTAMPTZ,          -- inclusivo (colombiaRangeBounds.gte)
    p_hasta      TIMESTAMPTZ,          -- EXCLUSIVO (colombiaRangeBounds.lt)
    p_limite     INT DEFAULT 60000
)
RETURNS TABLE (
    dia          DATE,
    utm_id       TEXT,
    utm_campaign TEXT,
    utm_content  TEXT,
    utm_term     TEXT,
    n            BIGINT,
    total_filas  BIGINT
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    IF p_limite IS NULL OR p_limite < 1 OR p_limite > 100000 THEN
        RAISE EXCEPTION 'bi_leads_por_dia: p_limite fuera de rango 1..100000 (recibido: %)', p_limite;
    END IF;

    IF p_desde IS NULL OR p_hasta IS NULL THEN
        RAISE EXCEPTION 'bi_leads_por_dia: p_desde y p_hasta son obligatorios';
    END IF;

    RETURN QUERY
    WITH grp AS (
        -- Día en hora Colombia, igual que la 071 y que `metricas_diarias.fecha`.
        -- Si este total se agrupara en UTC y el desglose en Colombia, el
        -- `(sin respuesta)` de los días de borde saldría negativo.
        SELECT (e.created_at AT TIME ZONE 'America/Bogota')::date AS dia,
               e.utm_id, e.utm_campaign, e.utm_content, e.utm_term,
               COUNT(*)::BIGINT AS n
        FROM report_utm.lead_events e
        WHERE (p_cliente_id IS NULL OR e.cliente_id = p_cliente_id)
          AND e.created_at >= p_desde
          AND e.created_at <  p_hasta
        -- Sin filtro por `raw_fields`: aquí se cuentan TODOS los contactos,
        -- respondan o no. Ese es justo el punto de esta función.
        GROUP BY 1, 2, 3, 4, 5
    )
    SELECT g.dia, g.utm_id, g.utm_campaign, g.utm_content, g.utm_term, g.n,
           COUNT(*) OVER ()::BIGINT
    FROM grp g
    ORDER BY g.n DESC, g.dia ASC
    LIMIT p_limite;
END;
$$;

COMMENT ON FUNCTION report_utm.bi_leads_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) IS
    'Contactos de report_utm.lead_events plegados por (día Colombia × tupla UTM). Es el denominador del desglose por respuesta y la métrica utm_leads del dashboard. NO es lo mismo que metricas_diarias.meta_leads: miden lo mismo desde fuentes distintas y se solapan.';

GRANT EXECUTE ON FUNCTION report_utm.bi_leads_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT)
    TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- Índice de cobertura: el que hace viable esta consulta en frío
-- ────────────────────────────────────────────────────────────────
-- Medido sobre el cliente más grande (Eduversio, 22.224 leads en un mes):
--
--   sin índice   Bitmap Heap Scan · 7.707 páginas ·  8.105 ms EN FRÍO  ← revienta
--                                                       460 ms en caliente
--   con índice   Index Only Scan  ·   453 páginas ·      562 ms leyendo de disco
--                                     Heap Fetches: 0
--
-- El `statement_timeout` es de 8 s, así que sin el índice la PRIMERA carga del
-- día de ese cliente fallaba. Cuesta 13 MB sobre una base de 435 MB con tope de
-- 500: es el único índice que se añade en todo el módulo y se paga solo.
--
-- La migración 070 documentó "no se añade NINGÚN índice" por ese mismo tope. Esto
-- no lo contradice: aquella consulta lee `raw_fields` (que no cabe en un índice)
-- y esta lee cuatro columnas cortas que sí caben.
CREATE INDEX IF NOT EXISTS idx_rutm_lead_events_utm_cover
    ON report_utm.lead_events (cliente_id, created_at)
    INCLUDE (utm_id, utm_campaign, utm_content, utm_term);

-- IMPRESCINDIBLE tras crearlo: un Index Only Scan necesita el mapa de
-- visibilidad, y sin VACUUM el planificador sigue eligiendo el bitmap heap scan
-- —se comprobó: el índice existía y no se usaba—. Después lo mantiene autovacuum.
VACUUM (ANALYZE) report_utm.lead_events;

COMMENT ON INDEX report_utm.idx_rutm_lead_events_utm_cover IS
    'Cobertura para bi_leads_por_dia / bi_respuestas_por_dia: permite Index Only Scan sobre las 4 columnas UTM y evita leer el heap (7.707 páginas → 453 en el cliente mayor).';
