-- ════════════════════════════════════════════════════════════════
-- Migration 090: Respuestas de formulario — una clave por respuesta y un cubo único
-- ════════════════════════════════════════════════════════════════
-- Sale de la auditoría de respuestas de formulario del 2026-09-26 (docs/17 y
-- docs/19). Dos cambios, los dos para que una respuesta de un desplegable se
-- pueda usar como MÉTRICA igual en las pestañas del dashboard y en los informes.
--
-- ── 1. `lead_campos.respuestas`: la clave de cada respuesta se GUARDA ─────
-- Hasta hoy la clave de fórmula de una respuesta (`lf__<campo>__<resp>`) se
-- derivaba de su etiqueta en cada carga. Renombrar «Calificadas» a
-- «Calificados» cambiaba la clave y dejaba en 0 toda tarjeta que la usara, sin
-- ningún aviso; y el sufijo `_2` de dos etiquetas con el mismo slug dependía del
-- orden por frecuencia, que cambia con el período.
--
-- `respuestas` es la lista [{clave, nombre, alias?}] del campo: la clave es
-- inmutable, el nombre sigue a la etiqueta vigente y `alias` recoge las claves
-- de respuestas renombradas o fusionadas, que siguen resolviendo. Es JSONB en la
-- propia fila del campo (y no una tabla aparte) porque se escribe SIEMPRE junto
-- al `valores_map` que la define: una sola fila, una sola escritura, sin
-- transacción repartida. `scripts/migrar-respuestas-lead.ts` la rellena
-- congelando las claves que el dashboard derivaba hasta ahora, así que ninguna
-- fórmula guardada cambia de significado.
--
-- `tipo` y `sincronizar_opciones` los usa la pantalla de Leads (fase 3):
-- `tipo` distingue un desplegable de una selección múltiple (que parte la
-- respuesta por sus opciones) y de texto libre.
--
-- ── 2. `leads_cubo`: UNA consulta para totales y todas las preguntas ─────
-- El dashboard hacía hasta cinco lecturas de `lead_events` por carga (el total
-- diario y una por pregunta, con tope de cuatro preguntas), y cada una paginada
-- con `.range()`, que re-ejecuta la función entera por página. Además esas RPC
-- no devolvían `campaign_id`/`adset_id`/`ad_id` (migración 082), así que un lead
-- con esos IDs podía caer en una campaña en el dashboard y en otra en el BI.
--
-- `leads_cubo` recorre el rango UNA vez, aplica `jsonb_each_text` una vez por
-- lead contra la unión de claves de todas las preguntas pedidas, y devuelve un
-- único JSONB (PostgREST no lo pagina):
--
--   {"tuplas":     [[utm_id, utm_campaign, utm_content, utm_term,
--                    campaign_id, adset_id, ad_id], ...],
--    "totales":    [[dia, iTupla, n], ...],
--    "respuestas": [[dia, iTupla, iCampo, valor, n], ...],
--    "truncado":   false}
--
-- La regla de la respuesta es la de siempre (071): por lead y pregunta, gana la
-- PRIMERA clave de origen con valor, en el orden de `claves_origen`. Sin
-- preguntas no se lee `raw_fields`.
--
-- Rangos: el llamador parte en ventanas de ≤ 366 días y las pide en serie
-- (`src/lib/leads/respuestas/cubo-db.ts`), como pide la instancia Micro.
--
-- REVERSIBLE:
--   DROP FUNCTION IF EXISTS report_utm.leads_cubo(UUID, TIMESTAMPTZ, TIMESTAMPTZ, JSONB, INT);
--   ALTER TABLE report_utm.lead_campos
--     DROP COLUMN IF EXISTS respuestas,
--     DROP COLUMN IF EXISTS tipo,
--     DROP COLUMN IF EXISTS sincronizar_opciones;
--
--   npx tsx scripts/sql-remoto.ts migrations/090_respuestas_de_lead.sql
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1) Claves de respuesta y tipo de pregunta
-- ────────────────────────────────────────────────────────────────
ALTER TABLE report_utm.lead_campos
    ADD COLUMN IF NOT EXISTS respuestas JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS tipo TEXT,
    ADD COLUMN IF NOT EXISTS sincronizar_opciones BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'lead_campos_tipo_check'
          AND conrelid = 'report_utm.lead_campos'::regclass
    ) THEN
        ALTER TABLE report_utm.lead_campos
            ADD CONSTRAINT lead_campos_tipo_check
            CHECK (tipo IS NULL OR tipo IN ('opcion', 'multiple', 'texto', 'numero'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'lead_campos_respuestas_array_check'
          AND conrelid = 'report_utm.lead_campos'::regclass
    ) THEN
        ALTER TABLE report_utm.lead_campos
            ADD CONSTRAINT lead_campos_respuestas_array_check
            CHECK (jsonb_typeof(respuestas) = 'array');
    END IF;
END $$;

COMMENT ON COLUMN report_utm.lead_campos.respuestas IS
    'Respuestas del campo con su clave estable: [{clave, nombre, alias?}]. La clave (slug inmutable) es la de la métrica lf__<campo>__<clave> / leadans:<campo>:<clave>; nombre sigue a la etiqueta vigente de valores_map; alias son claves antiguas que siguen resolviendo. Migración 090.';
COMMENT ON COLUMN report_utm.lead_campos.tipo IS
    'Tipo de pregunta: opcion (desplegable, una respuesta), multiple (varias, se parten por opción), texto, numero. NULL = sin determinar (se trata como opcion).';
COMMENT ON COLUMN report_utm.lead_campos.sincronizar_opciones IS
    'Si la plataforma (Meta, GHL, WordPress) publica una opción nueva, se añade sola como respuesta del campo.';

-- ────────────────────────────────────────────────────────────────
-- 2) Cubo único de leads y respuestas
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION report_utm.leads_cubo(
    p_cliente_id UUID,
    p_desde      TIMESTAMPTZ,
    p_hasta      TIMESTAMPTZ,
    p_campos     JSONB DEFAULT '[]'::jsonb,
    p_limite     INT   DEFAULT 150000
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
               (e.created_at AT TIME ZONE 'America/Bogota')::date AS dia,
               e.utm_id, e.utm_campaign, e.utm_content, e.utm_term,
               %s,
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
               c.campaign_id, c.adset_id, c.ad_id, COUNT(*)::bigint AS n
        FROM crudo c
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
    ), tup AS MATERIALIZED (
        -- La tupla (UTM + IDs) como texto JSON: es hashable, y a diferencia de
        -- concatenar distingue un NULL de la cadena 'null'.
        SELECT t.*, (ROW_NUMBER() OVER (ORDER BY t.tkey) - 1)::int AS i
        FROM (SELECT DISTINCT
                     jsonb_build_array(utm_id, utm_campaign, utm_content, utm_term,
                                       campaign_id, adset_id, ad_id)::text AS tkey,
                     utm_id, utm_campaign, utm_content, utm_term,
                     campaign_id, adset_id, ad_id
              FROM tot0) t
    ), tot AS (
        SELECT t.dia, tp.i, SUM(t.n)::bigint AS n
        FROM tot0 t
        JOIN tup tp
          ON tp.tkey = jsonb_build_array(t.utm_id, t.utm_campaign, t.utm_content, t.utm_term,
                                         t.campaign_id, t.adset_id, t.ad_id)::text
        GROUP BY 1, 2
    ), resp AS (
        -- La primera clave de origen con valor, por lead y pregunta (regla 071).
        SELECT DISTINCT ON (c.id, cl.icampo)
               c.dia, c.utm_id, c.utm_campaign, c.utm_content, c.utm_term,
               c.campaign_id, c.adset_id, c.ad_id,
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
               r.campaign_id, r.adset_id, r.ad_id, r.icampo, r.valor, COUNT(*)::bigint AS n
        FROM resp r
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
    ), grp AS (
        SELECT g.dia, tp.i, g.icampo, g.valor, SUM(g.n)::bigint AS n
        FROM grp0 g
        JOIN tup tp
          ON tp.tkey = jsonb_build_array(g.utm_id, g.utm_campaign, g.utm_content, g.utm_term,
                                         g.campaign_id, g.adset_id, g.ad_id)::text
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
                                               campaign_id, adset_id, ad_id) ORDER BY i)
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
    USING p_cliente_id, p_desde, p_hasta, p_campos, p_limite;

    RETURN v_out;
END;
$$;

COMMENT ON FUNCTION report_utm.leads_cubo(UUID, TIMESTAMPTZ, TIMESTAMPTZ, JSONB, INT) IS
    'Cubo único de contactos y respuestas de formulario: una pasada sobre lead_events, totales y respuestas por (día Colombia × tupla UTM+IDs), sin paginación. Ventana máxima 366 días. Migración 090.';

GRANT EXECUTE ON FUNCTION report_utm.leads_cubo(UUID, TIMESTAMPTZ, TIMESTAMPTZ, JSONB, INT)
    TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
