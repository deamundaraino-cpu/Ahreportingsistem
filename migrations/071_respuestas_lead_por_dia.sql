-- ════════════════════════════════════════════════════════════════
-- Migration 071: respuestas de formulario por día y tupla UTM
-- ════════════════════════════════════════════════════════════════
-- El General Overview (`/dashboard/[clientId]`) no veía un solo lead: los leads
-- y sus respuestas viven en `report_utm.lead_events.raw_fields` y solo el BI de
-- Report-UTM sabía agruparlos. Esta migración añade lo que falta para que una
-- pestaña del dashboard pueda mostrar "cuántos leads respondieron A, cuántos B
-- y cuántos C" respetando su filtro de campañas y su recorte de fechas.
--
-- ── Por qué una función nueva y no `bi_valores_conteo` (migración 070) ──
-- `bi_valores_conteo` devuelve (valor, n) para todo el rango: no tiene grano de
-- día ni de campaña. En la pestaña "Vista General" sin filtro daría el número
-- correcto, pero en CUALQUIER pestaña de campaña devolvería el total del cliente
-- etiquetado como si fuera el de esa campaña. Es exactamente el tipo de cifra
-- creíble y equivocada que el resto del módulo se esfuerza en evitar, así que
-- solo se conserva como camino degradado cuando no hay filtro que aplicar.
--
-- ── Por qué el cruce a campaña NO baja aquí ─────────────────────────────
-- Igual que la 070 §2: la cascada de 7 pasos (overrides del trafficker → utm_id
-- contra campaign_id → utm_id contra ad_id → nombres normalizados) vive en
-- TypeScript, cruza `metricas_diarias` y depende del índice de campañas.
-- Reimplementarla en plpgsql garantizaría que las dos copias divergieran. Lo que
-- sí baja es el PLEGADO previo: en vez de traer decenas de miles de leads con su
-- `raw_fields` completo, se devuelven las combinaciones DISTINTAS de
-- (día × respuesta × tupla UTM) con su recuento, y Node resuelve la campaña una
-- vez por tupla.
--
-- REVERSIBLE:
--   DROP FUNCTION IF EXISTS report_utm.bi_respuestas_por_dia(uuid,timestamptz,timestamptz,text[],int);
--   DROP FUNCTION IF EXISTS report_utm.norm_clave(text);
--   ALTER TABLE public.clientes_layouts DROP COLUMN IF EXISTS lead_answer_blocks;
--   ALTER TABLE public.cliente_tabs     DROP COLUMN IF EXISTS lead_answer_blocks;
--   ALTER TABLE public.tab_templates    DROP COLUMN IF EXISTS lead_answer_blocks;
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1) Normalizador de claves — el espejo SQL de `sanitizarColumna`
-- ────────────────────────────────────────────────────────────────
-- Las claves de `raw_fields` llegan tal como las escribió el formulario:
--   "cuantas propiedades tienes actualmente"   (con espacios)
--   "¿cuál_es_tu_rango_aproximado_de_ingresos?" (con signos y acentos)
--   "Rango de renta"                           (con mayúsculas)
-- mientras que `lead_campos.claves_origen` guarda la forma canónica. Buscar con
-- `raw_fields->>'<clave_normalizada>'` no encuentra NADA salvo en los
-- formularios de Meta, que ya envían snake_case — y ese fallo no se nota: la
-- consulta devuelve cero filas, que es indistinguible de "nadie respondió".
--
-- Esta función replica `sanitizarColumna` de `src/lib/sheets/campos.ts`:
-- minúsculas → sin acentos → todo lo que no sea [a-z0-9] a "_" → sin "_" en los
-- extremos. `verify-lead-answers-db` comprueba la equivalencia con las claves
-- reales de producción; si las dos divergieran, un campo dejaría de encontrar su
-- pregunta sin decir por qué.
--
-- `translate` en vez de `unaccent`: no requiere extensión y es IMMUTABLE de
-- verdad, lo que permite que el planificador la evalúe una sola vez por clave.
CREATE OR REPLACE FUNCTION report_utm.norm_clave(p TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT btrim(regexp_replace(
        translate(lower(coalesce(p, '')),
                  'áàâãäåéèêëíìîïóòôõöúùûüñç',
                  'aaaaaaeeeeiiiiooooouuuunc'),
        '[^a-z0-9]+', '_', 'g'), '_')
$$;

COMMENT ON FUNCTION report_utm.norm_clave(TEXT) IS
    'Clave de raw_fields → forma canónica. Espejo exacto de sanitizarColumna en src/lib/sheets/campos.ts: si divergieran, un campo de lead dejaría de encontrar su pregunta y la consulta devolvería cero en silencio.';

-- ────────────────────────────────────────────────────────────────
-- 2) Respuestas plegadas por día y tupla UTM
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
            (SELECT nullif(btrim(kv.value), '')
               FROM jsonb_each_text(e.raw_fields) AS kv
               JOIN unnest(p_claves_json) WITH ORDINALITY AS ck(clave, ord)
                 ON report_utm.norm_clave(kv.key) = ck.clave
              WHERE nullif(btrim(kv.value), '') IS NOT NULL
              ORDER BY ck.ord
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
    ORDER BY g.n DESC, g.dia ASC
    LIMIT p_limite;
END;
$$;

COMMENT ON FUNCTION report_utm.bi_respuestas_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], INT) IS
    'Respuestas de formulario plegadas por (día Colombia × valor × tupla UTM) con recuento. Alimenta el bloque de respuestas del dashboard general. Las claves se comparan por report_utm.norm_clave en ambos lados, espejo de indexarRawFields. La cascada UTM→campaña NO baja aquí a propósito (ver migración 070 §2).';

GRANT EXECUTE ON FUNCTION report_utm.norm_clave(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION report_utm.bi_respuestas_por_dia(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], INT)
    TO authenticated, service_role;

-- Sin SQL dinámico y sin índices nuevos:
--   • Las claves viajan como PARÁMETRO y se comparan como valores, no se
--     interpolan como identificadores. No hay superficie de inyección que
--     defender con una lista blanca, a diferencia de la 070.
--   • El filtro de rango ya usa `idx_rutm_lead_events_cliente`
--     (cliente_id, created_at DESC) y el resto se evalúa solo sobre las filas
--     supervivientes. La base está a 445 MB de un tope de 500.

-- ────────────────────────────────────────────────────────────────
-- 3) Columna del bloque en las tablas de layout
-- ────────────────────────────────────────────────────────────────
-- Mismo alcance exacto que `ranking_tables` (migración 018 + 036).
--
-- `public.layouts_reporte` NO la lleva, igual que `ranking_tables`: las
-- plantillas globales de layout solo definen columnas y tarjetas, y un bloque de
-- respuestas apunta a preguntas de UN cliente concreto, así que en una plantilla
-- global no significaría nada. Añadirla ahí crearía un cuarto camino de
-- resolución sin ningún caso de uso detrás.
ALTER TABLE public.clientes_layouts ADD COLUMN IF NOT EXISTS lead_answer_blocks JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.cliente_tabs     ADD COLUMN IF NOT EXISTS lead_answer_blocks JSONB DEFAULT NULL;
ALTER TABLE public.tab_templates    ADD COLUMN IF NOT EXISTS lead_answer_blocks JSONB;

COMMENT ON COLUMN public.cliente_tabs.lead_answer_blocks IS
    'Bloques de desglose de leads por respuesta de formulario. NULL = la pestaña hereda el layout del cliente (misma convención que ranking_tables).';
