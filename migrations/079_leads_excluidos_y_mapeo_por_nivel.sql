-- ════════════════════════════════════════════════════════════════
-- Migration 079: leads excluidos + mapeo manual por nivel
-- ════════════════════════════════════════════════════════════════
-- Dos cosas que pidió el PM en la reunión del 2026-09-08.
--
-- ── 1. Leads que no son captación pagada ─────────────────────────
-- En Cris Tributario 1.580 de 2.413 leads llegan sin NINGUNA señal de
-- atribución (ni utm_id, ni campaña, ni anuncio, ni conjunto): son contactos que
-- escribieron por WhatsApp directo, por el perfil de Instagram o que GHL creó por
-- otra vía. Caen en «(sin campaña)» y hunden el CPL.
--
-- Se decidió MARCARLOS, no borrarlos:
--   · auditable — el lead sigue ahí, con el motivo de por qué no cuenta;
--   · reversible — re-incluir es poner `excluido = false`;
--   · retroactivo — la misma regla se aplica al histórico sin re-sincronizar.
--
-- La regla vive por cliente en `report_utm.clientes.config.filtro_atribucion`
-- y la evalúa `src/lib/report-utm/lead-exclusion.ts`, que es la ÚNICA copia.
-- Esta migración no la reimplementa: solo añade la marca y hace que las RPC la
-- respeten.
--
-- ── 2. Mapeo manual por nivel ─────────────────────────────────────
-- `utm_campaign_map` solo sabía apuntar a una campaña. Cuando GHL manda el ID de
-- un conjunto o de un anuncio que el índice no conoce, el trafficker no tenía
-- dónde corregirlo.
--
-- Se amplía la MISMA fila con `nivel` + `target_*` en vez de crear otra tabla o
-- cambiar la clave única. Motivo: la app desplegada hace upsert con
-- `onConflict: 'cliente_id,match_field,match_value'`; tocar esa restricción
-- rompería el mapeo en producción hasta el siguiente despliegue. Y no hace falta
-- tocarla: un valor UTM apunta a UNA entidad, y una entidad de nivel conjunto o
-- anuncio sigue llevando su campaña en `campaign_id`/`campaign_name`, así que la
-- cascada de campaña funciona igual que siempre.
--
-- ── Espacio ──────────────────────────────────────────────────────
-- La base está cerca de su tope. `ADD COLUMN ... DEFAULT false` es solo
-- metadatos en Postgres ≥ 11 (no reescribe la tabla) y el único índice nuevo es
-- PARCIAL sobre los excluidos, que son minoría.
--
-- Idempotente. Compatible hacia atrás con el código desplegado: todo es aditivo
-- y las RPC conservan su firma.
--
-- REVERSIBLE:
--   ALTER TABLE report_utm.lead_events DROP COLUMN excluido, DROP COLUMN excluido_motivo,
--     DROP COLUMN excluido_at, DROP COLUMN excluido_por;
--   ALTER TABLE report_utm.utm_campaign_map DROP COLUMN nivel, DROP COLUMN target_id,
--     DROP COLUMN target_name;
--   y volver a aplicar migrations/070 y migrations/078 (las RPC).
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1) Marca de exclusión en los leads
-- ────────────────────────────────────────────────────────────────
ALTER TABLE report_utm.lead_events
    ADD COLUMN IF NOT EXISTS excluido        BOOLEAN     NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS excluido_motivo TEXT,
    ADD COLUMN IF NOT EXISTS excluido_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS excluido_por    UUID;

COMMENT ON COLUMN report_utm.lead_events.excluido IS
    'true = el lead se conserva pero NO cuenta en ninguna métrica (leads_count, CPL, respuestas, cruce). Lo marca la regla del cliente (lead-exclusion.ts) o una persona desde /report-utm/leads.';
COMMENT ON COLUMN report_utm.lead_events.excluido_motivo IS
    'sin_atribucion | source_excluida | formulario_excluido | manual';
COMMENT ON COLUMN report_utm.lead_events.excluido_por IS
    'Usuario que lo excluyó a mano. NULL = lo excluyó la regla automática (y la regla puede re-incluirlo).';

-- Solo los excluidos: es el conjunto pequeño y el que lista la UI. Los lectores
-- de métricas filtran `excluido = false` sobre el índice (cliente_id, created_at)
-- que ya existe; un índice parcial sobre los NO excluidos duplicaría la tabla.
CREATE INDEX IF NOT EXISTS idx_lead_events_excluidos
    ON report_utm.lead_events (cliente_id, created_at DESC)
    WHERE excluido;

-- ────────────────────────────────────────────────────────────────
-- 2) Mapeo manual por nivel
-- ────────────────────────────────────────────────────────────────
ALTER TABLE report_utm.utm_campaign_map
    ADD COLUMN IF NOT EXISTS nivel       TEXT NOT NULL DEFAULT 'campaign',
    ADD COLUMN IF NOT EXISTS target_id   TEXT,
    ADD COLUMN IF NOT EXISTS target_name TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'utm_campaign_map_nivel_check'
          AND conrelid = 'report_utm.utm_campaign_map'::regclass
    ) THEN
        ALTER TABLE report_utm.utm_campaign_map
            ADD CONSTRAINT utm_campaign_map_nivel_check
            CHECK (nivel IN ('campaign', 'adset', 'ad'));
    END IF;
END $$;

COMMENT ON COLUMN report_utm.utm_campaign_map.nivel IS
    'A qué nivel apunta la corrección. Con adset/ad, target_* es la entidad real y campaign_* su campaña, que la cascada sigue usando para el gasto.';

-- ────────────────────────────────────────────────────────────────
-- 3) Las RPC que cuentan leads respetan la marca
-- ────────────────────────────────────────────────────────────────
-- Mismo cuerpo que la 078 (respuestas y leads por día) y la 070 (valores), con
-- UNA línea más cada una. Se repite `SET search_path` porque un CREATE OR REPLACE
-- sin él deshace lo que fijó la 075.

CREATE OR REPLACE FUNCTION report_utm.bi_respuestas_por_dia(
    p_cliente_id  UUID,
    p_desde       TIMESTAMPTZ,
    p_hasta       TIMESTAMPTZ,
    p_claves_json TEXT[],
    p_limite      INT DEFAULT 60000
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
            (e.created_at AT TIME ZONE 'America/Bogota')::date AS dia,
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

CREATE OR REPLACE FUNCTION report_utm.bi_leads_por_dia(
    p_cliente_id UUID,
    p_desde      TIMESTAMPTZ,
    p_hasta      TIMESTAMPTZ,
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
        SELECT (e.created_at AT TIME ZONE 'America/Bogota')::date AS dia,
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

CREATE OR REPLACE FUNCTION report_utm.bi_valores_conteo(
    p_cliente_id  UUID,
    p_tabla       TEXT,
    p_desde       TIMESTAMPTZ,
    p_hasta       TIMESTAMPTZ,
    p_columna     TEXT   DEFAULT NULL,
    p_claves_json TEXT[] DEFAULT NULL,
    p_limite      INT    DEFAULT 200
)
RETURNS TABLE (valor TEXT, n BIGINT, total_distintos BIGINT)
LANGUAGE plpgsql
STABLE
SET search_path = report_utm, public, pg_temp
AS $$
DECLARE
    v_sql     TEXT;
    v_expr    TEXT;
    v_excluir TEXT;
BEGIN
    IF p_tabla NOT IN ('lead_events', 'sales_events') THEN
        RAISE EXCEPTION 'bi_valores_conteo: p_tabla debe ser lead_events o sales_events (recibido: %)', p_tabla;
    END IF;
    IF (p_columna IS NULL) = (p_claves_json IS NULL) THEN
        RAISE EXCEPTION 'bi_valores_conteo: indica p_columna O p_claves_json, no ambos ni ninguno';
    END IF;
    IF p_claves_json IS NOT NULL AND coalesce(array_length(p_claves_json, 1), 0) = 0 THEN
        RAISE EXCEPTION 'bi_valores_conteo: p_claves_json no puede ser un array vacío';
    END IF;
    IF p_claves_json IS NOT NULL AND p_tabla <> 'lead_events' THEN
        RAISE EXCEPTION 'bi_valores_conteo: raw_fields solo existe en lead_events (pedido sobre %)', p_tabla;
    END IF;
    IF p_limite IS NULL OR p_limite < 1 OR p_limite > 500 THEN
        RAISE EXCEPTION 'bi_valores_conteo: p_limite fuera de rango 1..500 (recibido: %)', p_limite;
    END IF;

    IF p_columna IS NOT NULL THEN
        IF p_tabla = 'lead_events' AND p_columna NOT IN (
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
            'utm_id', 'ip_country', 'form_name', 'form_plugin', 'attribution_method', 'source'
        ) THEN
            RAISE EXCEPTION 'bi_valores_conteo: columna % no permitida en lead_events', p_columna;
        END IF;
        IF p_tabla = 'sales_events' AND p_columna NOT IN (
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
            'utm_id', 'platform', 'product_name', 'transaction_type', 'customer_country', 'status'
        ) THEN
            RAISE EXCEPTION 'bi_valores_conteo: columna % no permitida en sales_events', p_columna;
        END IF;
        v_expr := format('e.%I::TEXT', p_columna);
    ELSE
        SELECT string_agg(format('NULLIF(btrim(e.raw_fields->>%L), '''')', k), ', ')
          INTO v_expr
          FROM unnest(p_claves_json) AS k;
        v_expr := format('COALESCE(%s)', v_expr);
    END IF;

    -- 079: `sales_events` no tiene la marca; solo los leads se excluyen. Es un
    -- literal fijo, no una entrada del usuario.
    v_excluir := CASE WHEN p_tabla = 'lead_events' THEN 'AND NOT e.excluido' ELSE '' END;

    v_sql := format($f$
        WITH base AS (
            SELECT %s AS valor
            FROM report_utm.%I e
            WHERE ($1::uuid IS NULL OR e.cliente_id = $1)
              AND e.created_at >= $2
              AND e.created_at <  $3
              %s
        ), grp AS (
            SELECT valor, COUNT(*)::BIGINT AS n
            FROM base
            WHERE valor IS NOT NULL AND btrim(valor) <> ''
            GROUP BY valor
        )
        SELECT valor, n, COUNT(*) OVER ()::BIGINT
        FROM grp
        ORDER BY n DESC, valor ASC
        LIMIT $4
    $f$, v_expr, p_tabla, v_excluir);

    RETURN QUERY EXECUTE v_sql
        USING p_cliente_id, p_desde, p_hasta, p_limite;
END;
$$;

CREATE OR REPLACE FUNCTION report_utm.bi_valores_utm(
    p_cliente_id UUID,
    p_tabla      TEXT,
    p_desde      TIMESTAMPTZ,
    p_hasta      TIMESTAMPTZ,
    p_limite     INT DEFAULT 5000
)
RETURNS TABLE (
    utm_id       TEXT,
    utm_campaign TEXT,
    utm_content  TEXT,
    utm_term     TEXT,
    n            BIGINT,
    total_tuplas BIGINT
)
LANGUAGE plpgsql
STABLE
SET search_path = report_utm, public, pg_temp
AS $$
DECLARE
    v_sql     TEXT;
    v_excluir TEXT;
BEGIN
    IF p_tabla NOT IN ('lead_events', 'sales_events') THEN
        RAISE EXCEPTION 'bi_valores_utm: p_tabla debe ser lead_events o sales_events (recibido: %)', p_tabla;
    END IF;
    IF p_limite IS NULL OR p_limite < 1 OR p_limite > 20000 THEN
        RAISE EXCEPTION 'bi_valores_utm: p_limite fuera de rango 1..20000 (recibido: %)', p_limite;
    END IF;

    v_excluir := CASE WHEN p_tabla = 'lead_events' THEN 'AND NOT e.excluido' ELSE '' END;

    v_sql := format($f$
        WITH grp AS (
            SELECT e.utm_id, e.utm_campaign, e.utm_content, e.utm_term,
                   COUNT(*)::BIGINT AS n
            FROM report_utm.%I e
            WHERE ($1::uuid IS NULL OR e.cliente_id = $1)
              AND e.created_at >= $2
              AND e.created_at <  $3
              %s
            GROUP BY 1, 2, 3, 4
        )
        SELECT utm_id, utm_campaign, utm_content, utm_term, n, COUNT(*) OVER ()::BIGINT
        FROM grp
        ORDER BY n DESC
        LIMIT $4
    $f$, p_tabla, v_excluir);

    RETURN QUERY EXECUTE v_sql USING p_cliente_id, p_desde, p_hasta, p_limite;
END;
$$;

GRANT EXECUTE ON FUNCTION report_utm.bi_respuestas_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], INT)
    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION report_utm.bi_leads_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT)
    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION report_utm.bi_valores_conteo(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT[], INT)
    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION report_utm.bi_valores_utm(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT)
    TO authenticated, service_role;
