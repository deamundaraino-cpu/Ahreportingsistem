-- ════════════════════════════════════════════════════════════════
-- Migration 064: ads_daily_resumen — la lectura que faltaba
-- ════════════════════════════════════════════════════════════════
-- La migración 063 creó `ads_daily` para dejar de leer los seis JSONB de
-- `metricas_diarias`, y la llenó (72.514 filas, 8 clientes, 99,4% con id). Pero
-- nunca se escribió el lector: el motor sigue sobre los JSONB, con todo lo que
-- eso arrastra —tramos de 10 días, tope de 5.000 filas SIN `.order()`, y cero
-- posibilidad de agrupar en la base—.
--
-- Esta función es ese lector.
--
-- ── p_nivel es OBLIGATORIO, y por eso no tiene DEFAULT ───────────
-- Los niveles de Meta NO suman entre sí: la deduplicación de atribución hace
-- que la suma de los anuncios de una campaña supere la cifra de la campaña, y
-- `reach` cuenta PERSONAS ÚNICAS. Un `SUM(spend)` sin fijar el nivel TRIPLICA el
-- gasto y devuelve un número perfectamente plausible.
--
-- Que el parámetro no tenga valor por defecto es la defensa: no se puede llamar
-- a esta función "sin querer" sobre los tres niveles. Además se valida en tiempo
-- de ejecución, porque un NULL explícito sí compilaría.
--
-- ── p_por_fecha decide el grano de salida ───────────────────────
--   false → una fila por entidad, agregando TODO el rango en la base. Es el caso
--           de «top campañas del mes»: una tabla de 20 filas en vez de 30 días
--           × N entidades viajando a Node para sumarse allí.
--   true  → una fila por (fecha, entidad), para las series temporales. El
--           recorte a semana/mes se hace arriba, que es donde vive el calendario
--           de Colombia.
--
-- ── eventos: la cola larga se suma clave a clave ────────────────
-- Las métricas "calientes" son columnas; el resto de eventos de píxel viven en
-- `eventos` JSONB. Se agregan sumando cada clave numérica por separado, para que
-- `search`, `contact` o una conversión personalizada del cliente sigan
-- disponibles con el mismo contrato que tienen hoy en el JSONB.
--
-- REVERSIBLE: solo crea una función. No modifica ni borra nada.
--   DROP FUNCTION IF EXISTS public.ads_daily_resumen(uuid, text, date, date, text, boolean);
-- ════════════════════════════════════════════════════════════════

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
    SELECT
        -- Con p_por_fecha = false todas las filas colapsan en una sola fecha
        -- NULL: es lo que convierte 30 días × N entidades en N filas.
        CASE WHEN p_por_fecha THEN a.fecha ELSE NULL END           AS fecha,
        a.plataforma,
        a.campana_nombre,
        a.adset_nombre,
        a.entidad_nombre,
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
    WHERE a.cliente_id = p_cliente_id
      AND a.nivel      = p_nivel
      AND a.fecha     >= p_desde
      AND a.fecha     <= p_hasta
      AND (p_plataforma IS NULL OR a.plataforma = p_plataforma)
    GROUP BY
        CASE WHEN p_por_fecha THEN a.fecha ELSE NULL END,
        a.plataforma, a.campana_nombre, a.adset_nombre, a.entidad_nombre;
END;
$$;

COMMENT ON FUNCTION public.ads_daily_resumen(UUID, TEXT, DATE, DATE, TEXT, BOOLEAN) IS
    'Lectura agregada de ads_daily. p_nivel es obligatorio y se valida: los niveles de Meta no suman entre sí y omitirlo triplica el gasto. p_por_fecha=false agrega todo el rango en la base (fecha sale NULL).';

-- La función se ejecuta con los permisos de quien llama, así que las políticas
-- de RLS de `ads_daily` (migración 063) siguen aplicando tal cual.
GRANT EXECUTE ON FUNCTION public.ads_daily_resumen(UUID, TEXT, DATE, DATE, TEXT, BOOLEAN)
    TO authenticated, service_role;
