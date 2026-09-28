-- ════════════════════════════════════════════════════════════════
-- Migration 095: días cortados en la zona del cliente (auditoría 2026-09-28)
-- ════════════════════════════════════════════════════════════════
-- Todo el sistema cortaba los días de leads y ventas en `America/Bogota`, pero el
-- gasto llega de Meta en el día de la CUENTA, y cinco de los seis clientes tienen
-- la cuenta en Chile (UTC-3/-4). Los leads entre las 22:00 y las 24:00 de Chile
-- caían en el día siguiente respecto a su gasto (docs/25).
--
-- Las tres funciones que agrupan leads por día reciben la zona:
--   · report_utm.leads_cubo            (090) — el cubo del dashboard;
--   · report_utm.bi_leads_por_dia      (079) — camino anterior a la 090;
--   · report_utm.bi_respuestas_por_dia (079) — ídem.
--
-- `p_zona` va AL FINAL y con DEFAULT 'America/Bogota': el código desplegado, que
-- no la manda, obtiene exactamente lo de antes, y el nuevo solo la manda cuando
-- el cliente no está en Colombia (`argsZona` en src/lib/zona-activa.ts).
--
-- Un parámetro más NO reemplaza la función: crea una sobrecarga, y las llamadas
-- con la firma vieja pasarían a ser ambiguas (42725). Por eso cada una se borra
-- con su firma exacta y se vuelve a crear en esta misma transacción, con sus
-- GRANT (no sobreviven al DROP).
--
-- `leads_cubo` añade además `utm_source` como OCTAVO elemento de cada tupla, al
-- final para no mover los índices que ya lee el código: el resolver lo usa para
-- no cruzar un nombre de campaña con la plataforma equivocada (migración 094).
--
-- Los cuerpos son los de la 079 y la 090 con esas líneas cambiadas; diferenciar
-- contra ellas antes de aplicar (regla 4 del doc 00).
--
-- REVERSIBLE: volver a aplicar las funciones de migrations/079 y migrations/090
-- (tras un DROP de las firmas con p_zona).
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1) leads_cubo
-- ────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS report_utm.leads_cubo(UUID, TIMESTAMPTZ, TIMESTAMPTZ, JSONB, INT);

CREATE OR REPLACE FUNCTION report_utm.leads_cubo(
    p_cliente_id UUID,
    p_desde      TIMESTAMPTZ,
    p_hasta      TIMESTAMPTZ,
    p_campos     JSONB DEFAULT '[]'::jsonb,
    p_limite     INT   DEFAULT 150000,
    p_zona       TEXT  DEFAULT 'America/Bogota'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = report_utm, public, pg_temp
AS $$
DECLARE
    v_out        JSONB;
    v_ids        TEXT;
    v_rf         TEXT;
BEGIN
    IF p_cliente_id IS NULL THEN
        RAISE EXCEPTION 'leads_cubo: p_cliente_id es obligatorio';
    END IF;
    IF p_desde IS NULL OR p_hasta IS NULL THEN
        RAISE EXCEPTION 'leads_cubo: p_desde y p_hasta son obligatorios';
    END IF;
    IF p_hasta - p_desde > INTERVAL '367 days' THEN
        RAISE EXCEPTION 'leads_cubo: la ventana máxima es de 366 días (pide el rango por tramos)';
    END IF;
    IF p_limite IS NULL OR p_limite < 1 OR p_limite > 300000 THEN
        RAISE EXCEPTION 'leads_cubo: p_limite fuera de rango 1..300000 (recibido: %)', p_limite;
    END IF;
    IF p_campos IS NULL OR jsonb_typeof(p_campos) <> 'array' THEN
        RAISE EXCEPTION 'leads_cubo: p_campos tiene que ser un array de arrays de claves';
    END IF;
    IF p_zona IS NULL OR btrim(p_zona) = '' THEN
        RAISE EXCEPTION 'leads_cubo: p_zona no puede ser vacía';
    END IF;

    -- Los IDs publicitarios dedicados existen desde la migración 082. Si todavía
    -- no está aplicada, la tupla lleva NULL en su lugar: el resolver cae a los
    -- UTM, que es exactamente lo que hacía el dashboard antes.
    v_ids := CASE WHEN EXISTS (
                 SELECT 1 FROM pg_attribute
                 WHERE attrelid = 'report_utm.lead_events'::regclass
                   AND attname = 'ad_id' AND NOT attisdropped)
             THEN 'e.campaign_id, e.adset_id, e.ad_id'
             ELSE 'NULL::text AS campaign_id, NULL::text AS adset_id, NULL::text AS ad_id'
             END;
    -- Sin preguntas no se lee raw_fields: es lo caro, y el total no lo necesita.
    v_rf := CASE WHEN jsonb_array_length(p_campos) > 0 THEN 'e.raw_fields' ELSE 'NULL::jsonb AS raw_fields' END;

    EXECUTE format($f$
    WITH claves AS (
        SELECT (c.ord - 1)::int AS icampo, k.ord::int AS ord, k.clave
        FROM jsonb_array_elements($4) WITH ORDINALITY AS c(arr, ord),
             jsonb_array_elements_text(c.arr) WITH ORDINALITY AS k(clave, ord)
        WHERE jsonb_typeof(c.arr) = 'array'
    ), crudo AS MATERIALIZED (
        -- UNA lectura de lead_events para todo lo demás.
        SELECT e.id,
               (e.created_at AT TIME ZONE $6)::date AS dia,               -- 095
               e.utm_id, e.utm_campaign, e.utm_content, e.utm_term,
               %s,
               e.utm_source,                                               -- 095
               %s
        FROM report_utm.lead_events e
        WHERE e.cliente_id = $1
          AND e.created_at >= $2
          AND e.created_at <  $3
          AND NOT e.excluido
    ), tot0 AS (
        -- Se agrupa ANTES de resolver la tupla: en el cliente más grande son
        -- ~5.000 grupos contra ~70.000 leads al trimestre.
        SELECT c.dia, c.utm_id, c.utm_campaign, c.utm_content, c.utm_term,
               c.campaign_id, c.adset_id, c.ad_id, c.utm_source, COUNT(*)::bigint AS n
        FROM crudo c
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
    ), tup AS MATERIALIZED (
        -- La tupla (UTM + IDs + fuente) como texto JSON: es hashable, y a
        -- diferencia de concatenar distingue un NULL de la cadena 'null'.
        SELECT t.*, (ROW_NUMBER() OVER (ORDER BY t.tkey) - 1)::int AS i
        FROM (SELECT DISTINCT
                     jsonb_build_array(utm_id, utm_campaign, utm_content, utm_term,
                                       campaign_id, adset_id, ad_id, utm_source)::text AS tkey,
                     utm_id, utm_campaign, utm_content, utm_term,
                     campaign_id, adset_id, ad_id, utm_source
              FROM tot0) t
    ), tot AS (
        SELECT t.dia, tp.i, SUM(t.n)::bigint AS n
        FROM tot0 t
        JOIN tup tp
          ON tp.tkey = jsonb_build_array(t.utm_id, t.utm_campaign, t.utm_content, t.utm_term,
                                         t.campaign_id, t.adset_id, t.ad_id, t.utm_source)::text
        GROUP BY 1, 2
    ), resp AS (
        -- La primera clave de origen con valor, por lead y pregunta (regla 071).
        SELECT DISTINCT ON (c.id, cl.icampo)
               c.dia, c.utm_id, c.utm_campaign, c.utm_content, c.utm_term,
               c.campaign_id, c.adset_id, c.ad_id, c.utm_source,
               cl.icampo, btrim(kv.value) AS valor
        FROM crudo c
        CROSS JOIN LATERAL jsonb_each_text(c.raw_fields) AS kv
        JOIN claves cl ON cl.clave = report_utm.norm_clave(kv.key)
        WHERE c.raw_fields IS NOT NULL
          AND jsonb_typeof(c.raw_fields) = 'object'
          AND nullif(btrim(kv.value), '') IS NOT NULL
        ORDER BY c.id, cl.icampo, cl.ord, kv.key
    ), grp0 AS (
        SELECT r.dia, r.utm_id, r.utm_campaign, r.utm_content, r.utm_term,
               r.campaign_id, r.adset_id, r.ad_id, r.utm_source,
               r.icampo, r.valor, COUNT(*)::bigint AS n
        FROM resp r
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
    ), grp AS (
        SELECT g.dia, tp.i, g.icampo, g.valor, SUM(g.n)::bigint AS n
        FROM grp0 g
        JOIN tup tp
          ON tp.tkey = jsonb_build_array(g.utm_id, g.utm_campaign, g.utm_content, g.utm_term,
                                         g.campaign_id, g.adset_id, g.ad_id, g.utm_source)::text
        GROUP BY 1, 2, 3, 4
    ), grp_lim AS (
        SELECT g.*, COUNT(*) OVER () AS total_grupos
        FROM grp g
        ORDER BY g.n DESC, g.dia, g.i, g.icampo, g.valor
        LIMIT $5
    )
    SELECT jsonb_build_object(
        'tuplas', COALESCE((
            SELECT jsonb_agg(jsonb_build_array(utm_id, utm_campaign, utm_content, utm_term,
                                               campaign_id, adset_id, ad_id, utm_source) ORDER BY i)
            FROM tup), '[]'::jsonb),
        'totales', COALESCE((
            SELECT jsonb_agg(jsonb_build_array(dia, i, n) ORDER BY dia, i) FROM tot),
            '[]'::jsonb),
        'respuestas', COALESCE((
            SELECT jsonb_agg(jsonb_build_array(dia, i, icampo, valor, n)
                             ORDER BY dia, i, icampo, valor)
            FROM grp_lim), '[]'::jsonb),
        'truncado', COALESCE((SELECT MAX(total_grupos) > $5 FROM grp_lim), false)
    )
    $f$, v_ids, v_rf)
    INTO v_out
    USING p_cliente_id, p_desde, p_hasta, p_campos, p_limite, p_zona;

    RETURN v_out;
END;
$$;

COMMENT ON FUNCTION report_utm.leads_cubo(UUID, TIMESTAMPTZ, TIMESTAMPTZ, JSONB, INT, TEXT) IS
    'Cubo único de contactos y respuestas de formulario: una pasada sobre lead_events, totales y respuestas por (día en p_zona × tupla UTM+IDs+fuente), sin paginación. Ventana máxima 366 días. Migraciones 090 y 095.';

GRANT EXECUTE ON FUNCTION report_utm.leads_cubo(UUID, TIMESTAMPTZ, TIMESTAMPTZ, JSONB, INT, TEXT)
    TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 2) bi_respuestas_por_dia
-- ────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS report_utm.bi_respuestas_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], INT);

CREATE OR REPLACE FUNCTION report_utm.bi_respuestas_por_dia(
    p_cliente_id  UUID,
    p_desde       TIMESTAMPTZ,
    p_hasta       TIMESTAMPTZ,
    p_claves_json TEXT[],
    p_limite      INT  DEFAULT 60000,
    p_zona        TEXT DEFAULT 'America/Bogota'
)
RETURNS TABLE (
    dia          DATE,
    valor        TEXT,
    utm_id       TEXT,
    utm_campaign TEXT,
    utm_content  TEXT,
    utm_term     TEXT,
    n            BIGINT,
    total_filas  BIGINT
)
LANGUAGE plpgsql
STABLE
SET search_path = report_utm, public, pg_temp
AS $$
BEGIN
    IF p_claves_json IS NULL OR coalesce(array_length(p_claves_json, 1), 0) = 0 THEN
        RAISE EXCEPTION 'bi_respuestas_por_dia: p_claves_json no puede ser NULL ni vacío';
    END IF;
    IF p_limite IS NULL OR p_limite < 1 OR p_limite > 100000 THEN
        RAISE EXCEPTION 'bi_respuestas_por_dia: p_limite fuera de rango 1..100000 (recibido: %)', p_limite;
    END IF;
    IF p_desde IS NULL OR p_hasta IS NULL THEN
        RAISE EXCEPTION 'bi_respuestas_por_dia: p_desde y p_hasta son obligatorios';
    END IF;

    RETURN QUERY
    WITH base AS MATERIALIZED (
        SELECT
            (e.created_at AT TIME ZONE p_zona)::date AS dia,               -- 095
            (SELECT nullif(btrim(kv.value), '')
               FROM jsonb_each_text(e.raw_fields) AS kv
               JOIN unnest(p_claves_json) WITH ORDINALITY AS ck(clave, ord)
                 ON report_utm.norm_clave(kv.key) = ck.clave
              WHERE nullif(btrim(kv.value), '') IS NOT NULL
              ORDER BY ck.ord, kv.key
              LIMIT 1) AS valor,
            e.utm_id, e.utm_campaign, e.utm_content, e.utm_term
        FROM report_utm.lead_events e
        WHERE (p_cliente_id IS NULL OR e.cliente_id = p_cliente_id)
          AND e.created_at >= p_desde
          AND e.created_at <  p_hasta
          AND e.raw_fields IS NOT NULL
          AND NOT e.excluido                                   -- 079
    ), grp AS (
        SELECT b.dia, b.valor, b.utm_id, b.utm_campaign, b.utm_content, b.utm_term,
               COUNT(*)::BIGINT AS n
        FROM base b
        WHERE b.valor IS NOT NULL
        GROUP BY 1, 2, 3, 4, 5, 6
    )
    SELECT g.dia, g.valor, g.utm_id, g.utm_campaign, g.utm_content, g.utm_term,
           g.n, COUNT(*) OVER ()::BIGINT
    FROM grp g
    ORDER BY g.n DESC, g.dia ASC,
             g.valor, g.utm_id, g.utm_campaign, g.utm_content, g.utm_term
    LIMIT p_limite;
END;
$$;

GRANT EXECUTE ON FUNCTION report_utm.bi_respuestas_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], INT, TEXT)
    TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 3) bi_leads_por_dia
-- ────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS report_utm.bi_leads_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT);

CREATE OR REPLACE FUNCTION report_utm.bi_leads_por_dia(
    p_cliente_id UUID,
    p_desde      TIMESTAMPTZ,
    p_hasta      TIMESTAMPTZ,
    p_limite     INT  DEFAULT 60000,
    p_zona       TEXT DEFAULT 'America/Bogota'
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
SET search_path = report_utm, public, pg_temp
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
        SELECT (e.created_at AT TIME ZONE p_zona)::date AS dia,             -- 095
               e.utm_id, e.utm_campaign, e.utm_content, e.utm_term,
               COUNT(*)::BIGINT AS n
        FROM report_utm.lead_events e
        WHERE (p_cliente_id IS NULL OR e.cliente_id = p_cliente_id)
          AND e.created_at >= p_desde
          AND e.created_at <  p_hasta
          AND NOT e.excluido                                   -- 079
        GROUP BY 1, 2, 3, 4, 5
    )
    SELECT g.dia, g.utm_id, g.utm_campaign, g.utm_content, g.utm_term, g.n,
           COUNT(*) OVER ()::BIGINT
    FROM grp g
    ORDER BY g.n DESC, g.dia ASC,
             g.utm_id, g.utm_campaign, g.utm_content, g.utm_term
    LIMIT p_limite;
END;
$$;

GRANT EXECUTE ON FUNCTION report_utm.bi_leads_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT, TEXT)
    TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
