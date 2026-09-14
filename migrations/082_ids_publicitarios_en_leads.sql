-- ════════════════════════════════════════════════════════════════
-- Migration 082: IDs publicitarios en los leads + gasto titulado por ID
-- ════════════════════════════════════════════════════════════════
-- Sale de la auditoría del cruce del 2026-09-14 (docs/22-auditoria-cruce-por-id.md).
--
-- ── 1. campaign_id / adset_id / ad_id en lead_events ─────────────
-- Un lead solo guardaba sus UTM. El ID de la entidad llegaba —si llegaba—
-- metido en `utm_id`, `utm_content` o `utm_term`, y el conjunto y el anuncio
-- cruzaban por NOMBRE. Los nombres fallan de dos formas medidas en producción:
--   · se repiten entre campañas (Eduversio: 83 de 91 nombres de anuncio), así
--     que un lead que solo trae el nombre no dice a qué campaña pertenece;
--   · se renombran, y el lead conserva el nombre del día en que entró.
-- Mientras tanto Meta Lead Ads recibía `ad_id` y `adset_id` con cada lead y los
-- tiraba, y GHL los dejaba enterrados en `custom_data`.
--
-- Tres columnas TEXT nullable, sin índice: se leen junto al resto de la fila del
-- lead (siempre filtrada por cliente y fecha), nunca se buscan por sí solas. La
-- base está cerca de su tope y un índice aquí sería espacio sin uso.
--
-- ── 2. ads_daily_resumen titula por el nombre MÁS RECIENTE del ID ─
-- La RPC agrupaba por nombre. Una campaña renombrada dentro del rango salía
-- partida en dos filas de gasto (auditoría: Sur Profundo 7 campañas en 90 días,
-- Somos 5, Expo 4, Cris 1), y los leads solo podían caer en una de las dos.
-- Ahora cada fila se titula con el nombre del día más reciente de su ID dentro
-- del rango, que es el mismo que usa el índice del resolver (campaign-resolver.ts,
-- `construirIndice`). Los totales no cambian: solo se funden las filas partidas.
-- Sin ID (entidades de TikTok antiguas) se usa el nombre de la fila, como antes.
--
-- Idempotente. Compatible con el código desplegado antes y después: el código
-- sondea las columnas (`src/lib/report-utm/lead-ids.ts`) y la RPC conserva su
-- firma y sus columnas de salida.
--
-- REVERSIBLE:
--   ALTER TABLE report_utm.lead_events
--     DROP COLUMN campaign_id, DROP COLUMN adset_id, DROP COLUMN ad_id;
--   y volver a aplicar migrations/064_ads_daily_resumen.sql y la línea de
--   migrations/075 que fija su search_path.
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1) IDs publicitarios dedicados
-- ────────────────────────────────────────────────────────────────
ALTER TABLE report_utm.lead_events
    ADD COLUMN IF NOT EXISTS campaign_id TEXT,
    ADD COLUMN IF NOT EXISTS adset_id    TEXT,
    ADD COLUMN IF NOT EXISTS ad_id       TEXT;

COMMENT ON COLUMN report_utm.lead_events.campaign_id IS
    'ID de la campaña (Meta/TikTok) del lead, cuando la fuente lo da: Meta Lead Ads, la atribución de GHL, o el parámetro campaign_id={{campaign.id}} del enlace (S2S). Cruce exacto; manda sobre los UTM.';
COMMENT ON COLUMN report_utm.lead_events.adset_id IS
    'ID del conjunto de anuncios (adGroupId en GHL, adset_id={{adset.id}} en el enlace). Titula el conjunto por ID aunque su nombre se repita o cambie.';
COMMENT ON COLUMN report_utm.lead_events.ad_id IS
    'ID del anuncio (ad_id={{ad.id}} en el enlace). El nivel más específico: da también su conjunto y su campaña.';

-- ────────────────────────────────────────────────────────────────
-- 2) Resumen de ads_daily con el nombre vigente de cada ID
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ads_daily_resumen(
    p_cliente_id  UUID,
    p_nivel       TEXT,
    p_desde       DATE,
    p_hasta       DATE,
    p_plataforma  TEXT    DEFAULT NULL,
    p_por_fecha   BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    fecha                   DATE,
    plataforma              TEXT,
    campana_nombre          TEXT,
    adset_nombre            TEXT,
    entidad_nombre          TEXT,
    spend                   NUMERIC,
    impressions             BIGINT,
    clicks                  BIGINT,
    reach                   BIGINT,
    link_clicks             BIGINT,
    leads_form              BIGINT,
    purchases               BIGINT,
    landing_page_views      BIGINT,
    complete_registration   BIGINT,
    adds_to_cart            BIGINT,
    initiates_checkout      BIGINT,
    view_content            BIGINT,
    video_views             BIGINT,
    video_thruplay          BIGINT,
    post_engagement         BIGINT,
    messaging_conversations BIGINT,
    conversions             BIGINT,
    eventos                 JSONB
)
LANGUAGE plpgsql
STABLE
SET search_path = public, report_utm, pg_temp
AS $$
BEGIN
    -- Se comprueba aunque el parámetro no tenga DEFAULT: un NULL explícito
    -- compilaría igual, y el resultado sería el gasto triplicado.
    IF p_nivel IS NULL OR p_nivel NOT IN ('campaign', 'adset', 'ad') THEN
        RAISE EXCEPTION
            'ads_daily_resumen: p_nivel debe ser campaign, adset o ad (recibido: %). Los niveles no suman entre sí.',
            COALESCE(p_nivel, 'NULL');
    END IF;

    RETURN QUERY
    WITH nombres AS (
        -- Nombre del día más reciente de cada ID dentro del rango. Todo
        -- cualificado con `n.`: los nombres de salida de la función
        -- (`campana_nombre`, `entidad_nombre`…) son variables en plpgsql.
        SELECT DISTINCT ON (n.plataforma, n.nivel, n.entidad_id)
               n.plataforma, n.nivel, n.entidad_id, n.entidad_nombre
        FROM public.ads_daily n
        WHERE n.cliente_id = p_cliente_id
          AND n.entidad_id IS NOT NULL
          AND n.fecha     >= p_desde
          AND n.fecha     <= p_hasta
          AND (p_plataforma IS NULL OR n.plataforma = p_plataforma)
        ORDER BY n.plataforma, n.nivel, n.entidad_id, n.fecha DESC
    )
    SELECT
        -- Con p_por_fecha = false todas las filas colapsan en una sola fecha
        -- NULL: es lo que convierte 30 días × N entidades en N filas.
        CASE WHEN p_por_fecha THEN a.fecha ELSE NULL END           AS fecha,
        a.plataforma,
        COALESCE(nc.entidad_nombre, a.campana_nombre)               AS campana_nombre,
        COALESCE(ns.entidad_nombre, a.adset_nombre)                 AS adset_nombre,
        COALESCE(ne.entidad_nombre, a.entidad_nombre)               AS entidad_nombre,
        SUM(a.spend)::NUMERIC                                       AS spend,
        SUM(a.impressions)::BIGINT                                  AS impressions,
        SUM(a.clicks)::BIGINT                                       AS clicks,
        -- `reach` se suma porque es lo que hace hoy el motor sobre el JSONB, y
        -- cambiar eso aquí movería cifras publicadas. Sigue sin ser aditivo
        -- entre entidades: el registro lo marca con `dedup` y la fila de totales
        -- del informe es la que se niega a sumarlo.
        SUM(a.reach)::BIGINT                                        AS reach,
        SUM(a.link_clicks)::BIGINT                                  AS link_clicks,
        SUM(a.leads_form)::BIGINT                                   AS leads_form,
        SUM(a.purchases)::BIGINT                                    AS purchases,
        SUM(a.landing_page_views)::BIGINT                           AS landing_page_views,
        SUM(a.complete_registration)::BIGINT                        AS complete_registration,
        SUM(a.adds_to_cart)::BIGINT                                 AS adds_to_cart,
        SUM(a.initiates_checkout)::BIGINT                           AS initiates_checkout,
        SUM(a.view_content)::BIGINT                                 AS view_content,
        SUM(a.video_views)::BIGINT                                  AS video_views,
        SUM(a.video_thruplay)::BIGINT                               AS video_thruplay,
        SUM(a.post_engagement)::BIGINT                              AS post_engagement,
        SUM(a.messaging_conversations)::BIGINT                      AS messaging_conversations,
        SUM(a.conversions)::BIGINT                                  AS conversions,
        -- Cola larga: se suma clave a clave. Las no numéricas (el objeto
        -- `custom`) se dejan fuera del sumatorio en vez de romper la consulta.
        (
            SELECT jsonb_object_agg(t.k, t.v)
            FROM (
                SELECT ev.key AS k, SUM((ev.value #>> '{}')::NUMERIC) AS v
                FROM unnest(array_agg(a.eventos)) AS todos(e),
                     jsonb_each(todos.e) AS ev
                WHERE jsonb_typeof(ev.value) = 'number'
                GROUP BY ev.key
            ) t
        )                                                           AS eventos
    FROM public.ads_daily a
    LEFT JOIN nombres nc
           ON nc.plataforma = a.plataforma AND nc.nivel = 'campaign' AND nc.entidad_id = a.campana_id
    LEFT JOIN nombres ns
           ON ns.plataforma = a.plataforma AND ns.nivel = 'adset' AND ns.entidad_id = a.adset_id
    LEFT JOIN nombres ne
           ON ne.plataforma = a.plataforma AND ne.nivel = a.nivel AND ne.entidad_id = a.entidad_id
    WHERE a.cliente_id = p_cliente_id
      AND a.nivel      = p_nivel
      AND a.fecha     >= p_desde
      AND a.fecha     <= p_hasta
      AND (p_plataforma IS NULL OR a.plataforma = p_plataforma)
    GROUP BY
        CASE WHEN p_por_fecha THEN a.fecha ELSE NULL END,
        a.plataforma,
        COALESCE(nc.entidad_nombre, a.campana_nombre),
        COALESCE(ns.entidad_nombre, a.adset_nombre),
        COALESCE(ne.entidad_nombre, a.entidad_nombre);
END;
$$;
