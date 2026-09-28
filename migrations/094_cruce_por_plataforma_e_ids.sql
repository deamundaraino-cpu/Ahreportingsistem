-- ════════════════════════════════════════════════════════════════
-- Migration 094: cruce por plataforma e IDs (auditoría del 2026-09-28)
-- ════════════════════════════════════════════════════════════════
-- Sale de la auditoría del cruce de campañas por canal
-- (docs/25-auditoria-cruce-canales.md). Tres funciones NUEVAS; no cambia ninguna
-- existente, así que el código desplegado sigue funcionando con o sin ella y el
-- código nuevo sondea cada función y cae a la anterior si falta.
--
-- ── 1. bi_valores_utm_v2 ────────────────────────────────────────
-- Los desplegables del BI resuelven cada tupla UTM con el MISMO resolver que el
-- motor, pero `bi_valores_utm` (079) no devolvía los IDs de la 082 ni la fuente.
-- Con la 082 aplicada el motor titula un lead por su `ad_id` y el desplegable
-- por su nombre: el filtro ofrecía una etiqueta y el informe agrupaba por otra.
-- Y desde este cambio el resolver usa `utm_source` para no cruzar un nombre con
-- la plataforma equivocada. En ventas, además, cuenta lo mismo que el motor:
-- solo aprobadas y sin el espejo de Hotmart (que se mide con hm_*).
-- Se crea con otro nombre porque cambiar las columnas de salida de una función
-- exige DROP, y el código desplegado la llama con la forma vieja.
--
-- ── 2. ads_entidades_ids ────────────────────────────────────────
-- El índice del resolver lee el JSONB de `metricas_diarias` desde 30 días antes
-- del rango. Una venta de Hotmart que hereda un lead de hace 3 meses trae un ID
-- que ya no está en esa ventana y cae al cruce por nombre (o a ninguno). Leer 180
-- días de JSONB costaría decenas de MB por informe; esta función devuelve solo la
-- identidad de cada entidad (una fila por ID, con su nombre más reciente), que
-- es lo único que hace falta para atar un ID a su campaña.
--
-- ── 3. hotmart_leads_para_atribucion_v2 ─────────────────────────
-- La herencia venta ← lead copiaba solo las 6 UTM. Los leads que solo traen IDs
-- (Meta Lead Ads, GHL) no eran candidatos, y los que sí, perdían su anuncio. La
-- v2 devuelve también `campaign_id / adset_id / ad_id` (082) y admite como
-- candidato un lead con cualquiera de ellos.
--
-- ── 4. sync_jobs_tipo_check ─────────────────────────────────────
-- Ver el apartado 4: el plan diario abortaba en producción.
--
-- Idempotente. REVERSIBLE (las funciones; el CHECK solo amplía):
--   DROP FUNCTION report_utm.bi_valores_utm_v2(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT);
--   DROP FUNCTION public.ads_entidades_ids(UUID, DATE, DATE);
--   DROP FUNCTION public.hotmart_leads_para_atribucion_v2(UUID, TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ);
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1) bi_valores_utm_v2
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION report_utm.bi_valores_utm_v2(
    p_cliente_id UUID,
    p_tabla      TEXT,
    p_desde      TIMESTAMPTZ,
    p_hasta      TIMESTAMPTZ,
    p_limite     INT DEFAULT 5000
)
RETURNS TABLE (
    utm_source   TEXT,
    utm_id       TEXT,
    utm_campaign TEXT,
    utm_content  TEXT,
    utm_term     TEXT,
    campaign_id  TEXT,
    adset_id     TEXT,
    ad_id        TEXT,
    n            BIGINT,
    total_tuplas BIGINT
)
LANGUAGE plpgsql
STABLE
SET search_path = report_utm, public, pg_temp
AS $$
DECLARE
    v_sql     TEXT;
    v_ids     TEXT;
    v_filtro  TEXT;
BEGIN
    IF p_tabla NOT IN ('lead_events', 'sales_events') THEN
        RAISE EXCEPTION 'bi_valores_utm_v2: p_tabla debe ser lead_events o sales_events (recibido: %)', p_tabla;
    END IF;
    IF p_limite IS NULL OR p_limite < 1 OR p_limite > 20000 THEN
        RAISE EXCEPTION 'bi_valores_utm_v2: p_limite fuera de rango 1..20000 (recibido: %)', p_limite;
    END IF;

    -- Las ventas guardan los IDs desde la 012 con otro nombre.
    IF p_tabla = 'lead_events' THEN
        v_ids    := 'e.campaign_id, e.adset_id, e.ad_id';
        v_filtro := 'AND NOT e.excluido';
    ELSE
        v_ids    := 'e.ad_campaign_id, e.ad_set_id, e.ad_id';
        v_filtro := $w$AND e.status = 'approved' AND e.platform <> 'hotmart'$w$;
    END IF;

    v_sql := format($f$
        WITH grp AS (
            SELECT e.utm_source, e.utm_id, e.utm_campaign, e.utm_content, e.utm_term,
                   %s,
                   COUNT(*)::BIGINT AS n
            FROM report_utm.%I e
            WHERE ($1::uuid IS NULL OR e.cliente_id = $1)
              AND e.created_at >= $2
              AND e.created_at <  $3
              %s
            GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
        )
        SELECT grp.*, COUNT(*) OVER ()::BIGINT
        FROM grp
        ORDER BY n DESC
        LIMIT $4
    $f$, v_ids, p_tabla, v_filtro);

    RETURN QUERY EXECUTE v_sql USING p_cliente_id, p_desde, p_hasta, p_limite;
END;
$$;

COMMENT ON FUNCTION report_utm.bi_valores_utm_v2(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT) IS
    'Tuplas (fuente, UTM, IDs) distintas con su recuento, para que los desplegables del BI resuelvan con el mismo resolver que el motor. En ventas: solo aprobadas y sin Hotmart. Migración 094.';

GRANT EXECUTE ON FUNCTION report_utm.bi_valores_utm_v2(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT)
    TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 2) ads_entidades_ids
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ads_entidades_ids(
    p_cliente_id UUID,
    p_desde      DATE,
    p_hasta      DATE
)
RETURNS TABLE (
    plataforma      TEXT,
    nivel           TEXT,
    entidad_id      TEXT,
    entidad_nombre  TEXT,
    campana_id      TEXT,
    campana_nombre  TEXT,
    adset_id        TEXT,
    adset_nombre    TEXT
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    -- Una fila por entidad con ID: la del día más reciente, que da el nombre
    -- vigente (el mismo criterio que ads_daily_resumen desde la 082).
    SELECT DISTINCT ON (a.plataforma, a.nivel, a.entidad_id)
           a.plataforma, a.nivel, a.entidad_id, a.entidad_nombre,
           a.campana_id, a.campana_nombre, a.adset_id, a.adset_nombre
      FROM public.ads_daily a
     WHERE a.cliente_id = p_cliente_id
       AND a.entidad_id IS NOT NULL
       AND a.fecha >= p_desde
       AND a.fecha <= p_hasta
     ORDER BY a.plataforma, a.nivel, a.entidad_id, a.fecha DESC
$$;

COMMENT ON FUNCTION public.ads_entidades_ids(UUID, DATE, DATE) IS
    'Identidad (ID, nombre vigente y jerarquía) de cada entidad publicitaria del cliente en el rango, sin métricas. Amplía el índice del resolver hacia atrás sin leer el JSONB. Migración 094.';

GRANT EXECUTE ON FUNCTION public.ads_entidades_ids(UUID, DATE, DATE)
    TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 3) hotmart_leads_para_atribucion_v2
-- ────────────────────────────────────────────────────────────────
-- Mismo cuerpo que la v1 (089) con las columnas de ID en la salida y en la
-- condición de candidato. La normalización de email y teléfono NO cambia: tiene
-- que coincidir con src/lib/hotmart/atribucion.ts.
CREATE OR REPLACE FUNCTION public.hotmart_leads_para_atribucion_v2(
    p_cliente_rtm UUID,
    p_emails      TEXT[],
    p_tel9        TEXT[],
    p_desde       TIMESTAMPTZ,
    p_hasta       TIMESTAMPTZ
)
RETURNS TABLE (
    id           UUID,
    created_at   TIMESTAMPTZ,
    email_norm   TEXT,
    tel9         TEXT,
    utm_source   TEXT,
    utm_medium   TEXT,
    utm_campaign TEXT,
    utm_content  TEXT,
    utm_term     TEXT,
    utm_id       TEXT,
    campaign_id  TEXT,
    adset_id     TEXT,
    ad_id        TEXT
)
LANGUAGE sql
STABLE
SET search_path = public, report_utm, pg_temp
AS $$
    SELECT l.id,
           l.created_at,
           lower(btrim(l.lead_email)),
           right(regexp_replace(COALESCE(l.lead_phone, ''), '\D', '', 'g'), 9),
           l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term, l.utm_id,
           l.campaign_id, l.adset_id, l.ad_id
      FROM report_utm.lead_events l
     WHERE l.cliente_id = p_cliente_rtm
       AND l.created_at >= p_desde
       AND l.created_at <  p_hasta
       AND NOT COALESCE(l.excluido, false)
       AND (l.utm_campaign IS NOT NULL OR l.utm_id IS NOT NULL
            OR l.campaign_id IS NOT NULL OR l.adset_id IS NOT NULL OR l.ad_id IS NOT NULL)
       AND (
             lower(btrim(l.lead_email)) = ANY (COALESCE(p_emails, ARRAY[]::TEXT[]))
          OR (length(regexp_replace(COALESCE(l.lead_phone, ''), '\D', '', 'g')) >= 8
              AND right(regexp_replace(COALESCE(l.lead_phone, ''), '\D', '', 'g'), 9)
                  = ANY (COALESCE(p_tel9, ARRAY[]::TEXT[])))
       )
$$;

COMMENT ON FUNCTION public.hotmart_leads_para_atribucion_v2(UUID, TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ) IS
    'Como la v1 (089), con los IDs publicitarios del lead (082) en la salida y como señal de candidato. Lo usa src/lib/hotmart/atribucion-db.ts. Migración 094.';

REVOKE ALL ON FUNCTION public.hotmart_leads_para_atribucion_v2(UUID, TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hotmart_leads_para_atribucion_v2(UUID, TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ)
    TO service_role;

-- ────────────────────────────────────────────────────────────────
-- 4) sync_jobs: los tipos que el código ya encola
-- ────────────────────────────────────────────────────────────────
-- Medido el 2026-09-28: el CHECK de producción es todavía el de la 066. La parte
-- de la 074 que añadía `ghl_leads` no llegó a aplicarse, así que `planDiario`
-- lanzaba al encolarlo y abortaba el resto del plan: 0 jobs `ghl_leads` en la
-- historia y la reconciliación diaria de Hotmart sin encolar. Se añaden además
-- los dos tipos nuevos de este cambio (oportunidades de GHL y leads de TikTok).
-- `utm_aggregate` y `sheets_leads` se conservan: hay filas históricas con ellos.
ALTER TABLE public.sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_tipo_check;
ALTER TABLE public.sync_jobs ADD CONSTRAINT sync_jobs_tipo_check CHECK (tipo = ANY (ARRAY[
    'metricas', 'sheets_leads', 'sheets_conversiones', 'meta_leads', 'utm_aggregate',
    'cierre_mes', 'reconciliar', 'hotmart_ventas', 'hotmart_reconciliar',
    'ghl_leads', 'ghl_oportunidades', 'tiktok_leads'
]::text[])) NOT VALID;
-- NOT VALID + VALIDATE: el ADD no recorre la tabla con el bloqueo fuerte; la
-- validación va aparte con un bloqueo que no frena los INSERT del worker.
ALTER TABLE public.sync_jobs VALIDATE CONSTRAINT sync_jobs_tipo_check;

NOTIFY pgrst, 'reload schema';
