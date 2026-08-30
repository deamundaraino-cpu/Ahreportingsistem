-- ════════════════════════════════════════════════════════════════
-- Migration 078: orden TOTAL en las RPC de respuestas por día
-- ════════════════════════════════════════════════════════════════
-- `bi_respuestas_por_dia` (071) y `bi_leads_por_dia` (072) terminan en
-- `ORDER BY g.n DESC, g.dia ASC`. Eso NO es un orden total: en 180 días hay
-- miles de filas con `n = 1` compartiendo el mismo día, así que los empates son
-- la norma y no la excepción.
--
-- Node las lee con `traerTodasLasFilas` (src/lib/report-utm/lead-answers-db.ts),
-- que pagina por OFFSET con `.range()` re-ejecutando la función completa en cada
-- página. Sin orden total, el orden de los empates puede cambiar entre
-- ejecuciones: unas filas salen en DOS páginas y otras en NINGUNA.
--
-- El comentario de `traerTodasLasFilas` ya afirmaba que "las dos RPC ordenan por
-- su GRANO COMPLETO". Era la precondición correcta; simplemente el SQL no la
-- cumplía. Esta migración la hace verdad.
--
-- ── Cómo se vio ─────────────────────────────────────────────────────────
-- `scripts/verify-lead-segmentos-db.ts` compara el conteo de un segmento por dos
-- caminos (motor del BI vs cubo del dashboard). Fallaba de forma INTERMITENTE:
-- tres pasadas seguidas el 2026-08-30 dieron verde, verde y
-- `dashboard=7128 vs bi=7127`. Un delta que aparece y desaparece es la firma de
-- una paginación inestable, no de un error de cálculo.
--
-- No era zona horaria: los dos caminos usan día Colombia y los mismos límites
-- (`colombiaRangeBounds` en Node, `AT TIME ZONE 'America/Bogota'` aquí).
--
-- ── Por qué el fallo era silencioso ─────────────────────────────────────
-- `traerTodasLasFilas` detecta el truncado con `filas.length < total_filas`. Si
-- una fila se duplica y otra se pierde, el recuento CUADRA y no salta nada. Por
-- eso el mismo commit añade una detección de duplicados por grano en Node.
--
-- ── Por qué `n DESC` sigue primero ──────────────────────────────────────
-- Es lo que decide qué se conserva cuando `LIMIT p_limite` recorta: las
-- combinaciones con más leads. Los desempates se AÑADEN detrás, así que el orden
-- visible no cambia; solo deja de ser ambiguo.
--
-- Los `utm_*` admiten NULL, pero el orden de Postgres con NULLs es determinista
-- (NULLS LAST en ASC), así que la tupla completa sí es un orden total.
--
-- ── Por qué se repite el SET search_path ────────────────────────────────
-- La migración 075 lo fijó con `ALTER FUNCTION`. Un `CREATE OR REPLACE` que no
-- lo repita deja la función SIN él y reabre el agujero que la 075 cerró.
--
-- Idempotente: se puede aplicar dos veces sin efecto.
--
-- REVERSIBLE: volver a aplicar migrations/071 y migrations/072, y después la
-- sección 3 de migrations/075.
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1) Respuestas plegadas por día y tupla UTM (migración 071)
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION report_utm.bi_respuestas_por_dia(
    p_cliente_id  UUID,
    p_desde       TIMESTAMPTZ,           -- inclusivo   (colombiaRangeBounds.gte)
    p_hasta       TIMESTAMPTZ,           -- EXCLUSIVO   (colombiaRangeBounds.lt)
    p_claves_json TEXT[],                -- claves YA normalizadas, EN ORDEN
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
    -- A diferencia de `bi_valores_conteo`, esta función NO acepta `p_tabla`:
    -- `sales_events` no tiene `raw_fields` y ofrecerlo solo abría la puerta al
    -- error que aquella tiene que cazar con una guarda. Decirlo en la firma es
    -- más barato que validarlo.
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
    -- MATERIALIZED no es decorativo. Sin él, el planificador empuja el
    -- `WHERE valor IS NOT NULL` dentro del scan y acaba evaluando la subconsulta
    -- del JSONB DOS VECES POR LEAD, una para el SELECT y otra para el filtro.
    -- Medido sobre Sur Profundo (3.598 leads de un mes): 3.074 ms sin
    -- materializar, 102 ms con él.
    WITH base AS MATERIALIZED (
        SELECT
            -- Día en hora Colombia, no UTC. `metricas_diarias.fecha` es día
            -- Colombia y el motor BI agrupa con `colombiaDateOf`; un tercer
            -- criterio aquí haría que el recorte por `fecha_inicio` de la
            -- pestaña moviera leads al día vecino. Medido en julio de 2026: el
            -- 26,9 % de los leads caía en el día equivocado cuando esto se hacía
            -- en UTC (ver src/lib/colombia-date.ts).
            --
            -- Se usa el NOMBRE de zona y no el literal '-05:00' porque, si algún
            -- día Colombia adoptase horario de verano, el nombre lo absorbe y la
            -- constante no. Hoy son idénticos (Bogotá es UTC-5 fijo).
            (e.created_at AT TIME ZONE 'America/Bogota')::date AS dia,

            -- Primera clave CON VALOR, en el orden de `p_claves_json`. Es el
            -- espejo exacto de `bucketDeLead` en Node. Agrupar cada clave por
            -- separado y sumar después contaría DOS VECES al lead que responde a
            -- varias —el caso real de Goodprop, que recibe la misma pregunta
            -- desde Meta y desde la web— y el recuento saldría inflado sin que
            -- nada lo delatara.
            --
            -- La comparación va por `norm_clave` en los DOS lados, igual que
            -- `indexarRawFields`: así "Rango de renta", "rango_de_renta" y
            -- "¿Rango de renta?" son la misma pregunta.
            --
            -- El desempate por `kv.key` es nuevo (078): si dos claves crudas
            -- distintas normalizan a la MISMA `ck.clave`, el `ORDER BY ck.ord`
            -- empataba y Postgres elegía una arbitrariamente, mientras Node
            -- desempata siempre por el orden de `Object.entries`. Dos espejos que
            -- podían discrepar en el mismo lead.
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
    ), grp AS (
        SELECT b.dia, b.valor, b.utm_id, b.utm_campaign, b.utm_content, b.utm_term,
               COUNT(*)::BIGINT AS n
        FROM base b
        WHERE b.valor IS NOT NULL
        GROUP BY 1, 2, 3, 4, 5, 6
    )
    -- `total_filas` sale de COUNT(*) OVER (): permite a Node DETECTAR que la
    -- consulta se truncó y avisarlo en la UI, en vez de mostrar de menos con
    -- aspecto de dato completo.
    SELECT g.dia, g.valor, g.utm_id, g.utm_campaign, g.utm_content, g.utm_term,
           g.n, COUNT(*) OVER ()::BIGINT
    FROM grp g
    -- ORDEN TOTAL (078). `n DESC, dia ASC` decide QUÉ sobrevive al LIMIT; el
    -- resto de la tupla solo desempata, para que trocear por OFFSET sea estable.
    -- Es el GRANO COMPLETO del GROUP BY de arriba: no quitar ninguna columna.
    ORDER BY g.n DESC, g.dia ASC,
             g.valor, g.utm_id, g.utm_campaign, g.utm_content, g.utm_term
    LIMIT p_limite;
END;
$$;

COMMENT ON FUNCTION report_utm.bi_respuestas_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], INT) IS
    'Respuestas de formulario plegadas por (día Colombia × valor × tupla UTM) con recuento. Alimenta el bloque de respuestas del dashboard general. Las claves se comparan por report_utm.norm_clave en ambos lados, espejo de indexarRawFields. La cascada UTM→campaña NO baja aquí a propósito (ver migración 070 §2). El ORDER BY cubre el grano completo (migración 078): es la precondición de la paginación por OFFSET de traerTodasLasFilas.';

-- ────────────────────────────────────────────────────────────────
-- 2) Total diario de contactos (migración 072)
-- ────────────────────────────────────────────────────────────────
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
    -- ORDEN TOTAL (078). Mismo motivo que en `bi_respuestas_por_dia`: sin los
    -- desempates, paginar por OFFSET duplica unas filas y pierde otras.
    ORDER BY g.n DESC, g.dia ASC,
             g.utm_id, g.utm_campaign, g.utm_content, g.utm_term
    LIMIT p_limite;
END;
$$;

COMMENT ON FUNCTION report_utm.bi_leads_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT) IS
    'Contactos de report_utm.lead_events plegados por (día Colombia × tupla UTM). Es el denominador del desglose por respuesta y la métrica utm_leads del dashboard. NO es lo mismo que metricas_diarias.meta_leads: miden lo mismo desde fuentes distintas y se solapan. El ORDER BY cubre el grano completo (migración 078).';

-- ────────────────────────────────────────────────────────────────
-- 3) Permisos (CREATE OR REPLACE los conserva, pero repetirlos es barato
--    y deja la migración aplicable sobre una base que aún no tenga las
--    funciones porque nunca corrió la 071/072).
-- ────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION report_utm.bi_respuestas_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], INT)
    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION report_utm.bi_leads_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT)
    TO authenticated, service_role;
