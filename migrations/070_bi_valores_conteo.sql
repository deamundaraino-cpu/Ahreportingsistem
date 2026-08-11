-- ════════════════════════════════════════════════════════════════
-- Migration 070: valores distintos CON RECUENTO, agregados en la base
-- ════════════════════════════════════════════════════════════════
-- Para filtrar por una campaña había que escribir su nombre a mano. Estas
-- funciones son lo que permite ofrecerla en una lista de casillas con su
-- recuento, como en una tabla dinámica de Excel.
--
-- ── Lo que arreglan, además de añadir el conteo ──────────────────
-- La rama genérica de `runDistinctValues` hacía:
--
--     .select(col).limit(5000)          -- una sola página, SIN order by
--
-- y deduplicaba en Node. Con 22.227 leads en un mes, QUÉ valores llegaban era
-- indefinido y la cola larga simplemente no aparecía. El resultado parecía
-- correcto: una lista de valores plausibles, incompleta en silencio.
--
-- Agregando en la base el corte deja de ser arbitrario (los N más frecuentes) y
-- viajan ~50 filas en vez de 22.000.
--
-- ── SQL dinámico: por qué es seguro ─────────────────────────────
-- `p_columna` se interpola como identificador porque un GROUP BY no admite
-- parámetro. La defensa es una LISTA BLANCA dentro de la función —no en el
-- cliente, donde sería saltable— más `%I` para el identificador y `USING` para
-- todos los valores. Una columna fuera de la lista aborta con excepción.
--
-- `SECURITY INVOKER` (el de por defecto): las políticas RLS de las tablas
-- siguen aplicando tal cual.
--
-- ── Rendimiento medido ──────────────────────────────────────────
-- Sobre el cliente más grande (22.227 leads en un mes), con statement_timeout
-- de 8 s:
--     GROUP BY columna directa   3,9 s en frío   37 ms en caliente
--     GROUP BY raw_fields->>k    1,9 s en frío
-- Margen de 4x sobre el límite. No se añade NINGÚN índice: la base está a
-- 445 MB de un tope de 500 MB. La palanca es la caché en Node, no el índice.
--
-- REVERSIBLE: solo crea funciones.
--   DROP FUNCTION IF EXISTS report_utm.bi_valores_conteo(uuid,text,timestamptz,timestamptz,text,text[],int);
--   DROP FUNCTION IF EXISTS report_utm.bi_valores_utm(uuid,text,timestamptz,timestamptz,int);
--   DROP FUNCTION IF EXISTS public.hotmart_valores_conteo(uuid,text,date,date,text,int);
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1) Columna directa o clave de raw_fields
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION report_utm.bi_valores_conteo(
    p_cliente_id  UUID,
    p_tabla       TEXT,                  -- 'lead_events' | 'sales_events'
    p_desde       TIMESTAMPTZ,           -- inclusivo (colombiaRangeBounds.gte)
    p_hasta       TIMESTAMPTZ,           -- EXCLUSIVO (colombiaRangeBounds.lt)
    p_columna     TEXT   DEFAULT NULL,   -- columna directa
    p_claves_json TEXT[] DEFAULT NULL,   -- claves dentro de raw_fields
    p_limite      INT    DEFAULT 200
)
RETURNS TABLE (valor TEXT, n BIGINT, total_distintos BIGINT)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_sql  TEXT;
    v_expr TEXT;
BEGIN
    IF p_tabla NOT IN ('lead_events', 'sales_events') THEN
        RAISE EXCEPTION 'bi_valores_conteo: p_tabla debe ser lead_events o sales_events (recibido: %)', p_tabla;
    END IF;

    -- Exactamente uno de los dos. Con ambos o con ninguno la consulta no está
    -- definida, y adivinar produciría una lista plausible pero equivocada.
    IF (p_columna IS NULL) = (p_claves_json IS NULL) THEN
        RAISE EXCEPTION 'bi_valores_conteo: indica p_columna O p_claves_json, no ambos ni ninguno';
    END IF;

    IF p_claves_json IS NOT NULL AND coalesce(array_length(p_claves_json, 1), 0) = 0 THEN
        RAISE EXCEPTION 'bi_valores_conteo: p_claves_json no puede ser un array vacío';
    END IF;

    -- `sales_events` NO tiene raw_fields. Sin esta guarda, Postgres fallaría con
    -- «column does not exist» y Node lo traduciría a «sin valores»: un fallo de
    -- programación disfrazado de dato.
    IF p_claves_json IS NOT NULL AND p_tabla <> 'lead_events' THEN
        RAISE EXCEPTION 'bi_valores_conteo: raw_fields solo existe en lead_events (pedido sobre %)', p_tabla;
    END IF;

    IF p_limite IS NULL OR p_limite < 1 OR p_limite > 500 THEN
        RAISE EXCEPTION 'bi_valores_conteo: p_limite fuera de rango 1..500 (recibido: %)', p_limite;
    END IF;

    -- ── LISTA BLANCA ────────────────────────────────────────────
    -- Espejo de LEAD_FILTER_KEYS / SALES_FILTER_KEYS en bi-query.ts. Es la
    -- única defensa contra la inyección por identificador, y por eso vive aquí
    -- dentro y no en quien llama.
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
        -- COALESCE sobre las claves EN ORDEN: reproduce exactamente lo que hace
        -- `bucketDeLead` en Node, que se queda con la primera clave que trae
        -- valor. Agrupar cada clave por separado y sumar después contaría dos
        -- veces al lead que responde a varias, y el recuento saldría inflado sin
        -- que nada lo delatara.
        --
        -- Las claves van como literales (`%L`), no como identificadores: son
        -- contenido de un JSONB, no nombres de columna, así que no necesitan
        -- lista blanca y no pueden alterar la estructura de la consulta.
        SELECT string_agg(format('NULLIF(btrim(e.raw_fields->>%L), '''')', k), ', ')
          INTO v_expr
          FROM unnest(p_claves_json) AS k;
        v_expr := format('COALESCE(%s)', v_expr);
    END IF;

    v_sql := format($f$
        WITH base AS (
            SELECT %s AS valor
            FROM report_utm.%I e
            WHERE ($1::uuid IS NULL OR e.cliente_id = $1)
              AND e.created_at >= $2
              AND e.created_at <  $3
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
    $f$, v_expr, p_tabla);

    RETURN QUERY EXECUTE v_sql
        USING p_cliente_id, p_desde, p_hasta, p_limite;
END;
$$;

COMMENT ON FUNCTION report_utm.bi_valores_conteo(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT[], INT) IS
    'Valores distintos con recuento de una columna (o clave de raw_fields) de lead_events/sales_events. Sustituye al escaneo de 5.000 filas sin ORDER BY, cuyo corte era indefinido. p_columna va contra lista blanca interna: es la defensa contra inyección por identificador. total_distintos sale de COUNT(*) OVER (), sin un count exacto aparte.';

-- ────────────────────────────────────────────────────────────────
-- 2) Tuplas UTM plegadas, para las dimensiones unificadas
-- ────────────────────────────────────────────────────────────────
-- La cascada que resuelve un UTM a su campaña real (overrides del trafficker →
-- utm_id contra campaign_id → utm_id contra ad_id → nombres normalizados) vive
-- en TypeScript, cruza `metricas_diarias` y depende del índice de campañas.
-- NO baja a SQL: reimplementarla en plpgsql garantizaría que las dos copias
-- divergieran, y entonces el desplegable ofrecería valores que el motor no
-- agrupa igual.
--
-- Lo que sí baja es el PLEGADO previo: en vez de traer 22.227 filas con sus
-- cuatro columnas UTM, se devuelven las tuplas DISTINTAS con su recuento —
-- unos cientos—. Node resuelve una vez por tupla en vez de una vez por fila.
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
AS $$
DECLARE
    v_sql TEXT;
BEGIN
    IF p_tabla NOT IN ('lead_events', 'sales_events') THEN
        RAISE EXCEPTION 'bi_valores_utm: p_tabla debe ser lead_events o sales_events (recibido: %)', p_tabla;
    END IF;
    IF p_limite IS NULL OR p_limite < 1 OR p_limite > 20000 THEN
        RAISE EXCEPTION 'bi_valores_utm: p_limite fuera de rango 1..20000 (recibido: %)', p_limite;
    END IF;

    v_sql := format($f$
        WITH grp AS (
            SELECT e.utm_id, e.utm_campaign, e.utm_content, e.utm_term,
                   COUNT(*)::BIGINT AS n
            FROM report_utm.%I e
            WHERE ($1::uuid IS NULL OR e.cliente_id = $1)
              AND e.created_at >= $2
              AND e.created_at <  $3
            GROUP BY 1, 2, 3, 4
        )
        SELECT utm_id, utm_campaign, utm_content, utm_term, n, COUNT(*) OVER ()::BIGINT
        FROM grp
        ORDER BY n DESC
        LIMIT $4
    $f$, p_tabla);

    RETURN QUERY EXECUTE v_sql USING p_cliente_id, p_desde, p_hasta, p_limite;
END;
$$;

COMMENT ON FUNCTION report_utm.bi_valores_utm(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT) IS
    'Tuplas UTM distintas con recuento, para que Node resuelva la etiqueta real una vez por tupla en vez de una vez por fila. La cascada del resolver NO baja a SQL a propósito: duplicarla haría que el desplegable y el motor divergieran.';

-- ────────────────────────────────────────────────────────────────
-- 3) Hotmart
-- ────────────────────────────────────────────────────────────────
-- Función aparte, y no un `p_tabla` más de la primera, por una razón que no es
-- estética: `public.hotmart_ventas` cuelga del cliente PÚBLICO, no del cliente
-- de report_utm. Son dos espacios de identificadores distintos y mezclarlos en
-- una firma común sería justo el tipo de trampa implícita que hace que alguien
-- pase el id equivocado y reciba cero filas sin ningún error.
CREATE OR REPLACE FUNCTION public.hotmart_valores_conteo(
    p_cliente_publico_id UUID,
    p_columna            TEXT,
    p_desde              DATE,
    p_hasta              DATE,
    p_limite             INT DEFAULT 200
)
RETURNS TABLE (valor TEXT, n BIGINT, total_distintos BIGINT)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_sql TEXT;
BEGIN
    -- Espejo de HOTMART_DIM_COL en bi-query.ts.
    IF p_columna NOT IN ('tipo', 'oferta_codigo', 'producto_nombre', 'comprador_pais', 'pago_tipo') THEN
        RAISE EXCEPTION 'hotmart_valores_conteo: columna % no permitida', p_columna;
    END IF;
    IF p_limite IS NULL OR p_limite < 1 OR p_limite > 500 THEN
        RAISE EXCEPTION 'hotmart_valores_conteo: p_limite fuera de rango 1..500 (recibido: %)', p_limite;
    END IF;

    v_sql := format($f$
        WITH grp AS (
            SELECT h.%I::TEXT AS valor, COUNT(*)::BIGINT AS n
            FROM public.hotmart_ventas h
            WHERE h.cliente_id = $1
              AND h.fecha_venta >= $2
              AND h.fecha_venta <= $3
              AND h.%I IS NOT NULL
              AND btrim(h.%I::TEXT) <> ''
            GROUP BY 1
        )
        SELECT valor, n, COUNT(*) OVER ()::BIGINT
        FROM grp
        ORDER BY n DESC, valor ASC
        LIMIT $4
    $f$, p_columna, p_columna, p_columna);

    RETURN QUERY EXECUTE v_sql USING p_cliente_publico_id, p_desde, p_hasta, p_limite;
END;
$$;

COMMENT ON FUNCTION public.hotmart_valores_conteo(UUID, TEXT, DATE, DATE, INT) IS
    'Valores distintos con recuento de hotmart_ventas. p_cliente_publico_id es el id de public.clientes, NO el de report_utm.clientes: son espacios distintos y el nombre lo dice para que nadie los confunda.';

GRANT EXECUTE ON FUNCTION report_utm.bi_valores_conteo(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT[], INT)
    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION report_utm.bi_valores_utm(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT)
    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.hotmart_valores_conteo(UUID, TEXT, DATE, DATE, INT)
    TO authenticated, service_role;
