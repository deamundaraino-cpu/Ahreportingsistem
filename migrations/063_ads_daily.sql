-- ════════════════════════════════════════════════════════════════
-- Migration 063: ads_daily — tabla de hechos normalizada de publicidad
-- ════════════════════════════════════════════════════════════════
-- Hoy el gasto se lee de los 6 JSONB de `public.metricas_diarias`
-- (meta_campaigns/meta_adsets/meta_ads, tiktok_campaigns/tiktok_adgroups/
-- tiktok_ads). Eso obliga a:
--
--   • Leer en tramos de 10 días, porque pedir 120 de golpe producía respuestas
--     de varios MB que PostgREST devolvía TRUNCADAS de forma intermitente y SIN
--     error — el mismo informe daba 1.315 leads en una carga y 57 en la
--     siguiente (ver campaign-resolver.ts:143).
--   • Traerse los arrays enteros a Node para sumarlos, con un tope de 5.000
--     filas SIN `.order()`: si se supera, qué días llegan es indefinido.
--   • Renunciar a cualquier GROUP BY en SQL.
--
-- Con esta tabla el índice de campañas se construye con un SELECT y el gasto se
-- agrega en la base.
--
-- ── UNA FILA POR NIVEL, a propósito ─────────────────────────────
-- Los niveles de Meta NO suman entre sí (la deduplicación de atribución hace que
-- sumar los anuncios de una campaña sobrepase la cifra de la campaña), y
-- `reach`/`frequency` cuentan PERSONAS ÚNICAS. Reproducir lo que muestra el
-- Administrador de Anuncios exige guardar lo que la plataforma reporta en cada
-- nivel, no calcular un rollup.
--
-- CONSECUENCIA CRÍTICA: toda lectura DEBE fijar `nivel`. Un `SUM(spend)` sin
-- filtrarlo TRIPLICA el gasto y el número parece plausible. La firma de la RPC de
-- lectura hace `p_nivel` obligatorio, y `scripts/verify-ads-daily.ts` falla si
-- encuentra en el repo un `from('ads_daily')` sin `.eq('nivel'`.
--
-- ── ALCANCE ACOTADO POR ALMACENAMIENTO ──────────────────────────
-- La base está en 293 MB contra el tope de 500 MB del plan (la migración 061
-- existe porque llegó a 539 MB y hubo que soltar una tabla y seis índices).
-- Medido sobre los datos reales:
--
--   histórico completo   171.666 filas   ≈ 140-150 MB con todos los índices
--   campaña + conjunto    59.866 filas
--   nivel anuncio        111.800 filas   (65% del total; TikTok solo, 77.120)
--
-- Por eso:
--   • Campaña y conjunto se guardan SIEMPRE (son los ejes con los que se agrupan
--     los informes, incluso los antiguos).
--   • Nivel anuncio se retiene solo los últimos 30 días (`purgar_ads_daily`).
--   • NO se crea índice GIN sobre `eventos`: la cola larga de eventos se lee por
--     clave conocida, nunca se busca por contenido. Era el índice más caro.
--
-- `metricas_diarias` SIGUE siendo la capa cruda: el dashboard clásico lee sus
-- arrays y los filtra por keyword para cada pestaña. Las dos tablas CONVIVEN.
-- Soltar los JSONB solo será posible tras migrar ese dashboard.
--
-- REVERSIBLE: es una tabla nueva y aditiva. No modifica ni borra nada existente.
--   DROP TABLE IF EXISTS public.ads_daily CASCADE;
--   DROP FUNCTION IF EXISTS public.purgar_ads_daily(integer);
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ads_daily (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id      UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    fecha           DATE NOT NULL,
    plataforma      TEXT NOT NULL CHECK (plataforma IN ('meta', 'tiktok')),
    nivel           TEXT NOT NULL CHECK (nivel IN ('campaign', 'adset', 'ad')),

    -- ── Identidad de la entidad ─────────────────────────────────
    -- `entidad_key` es la clave del UNIQUE, NO `entidad_id`: en Postgres dos
    -- NULL son distintos dentro de un índice único, así que las entidades sin id
    -- (los objetos de TikTok antes de pedirle los atributos) se duplicarían en
    -- cada sincronización. Vale el id cuando existe, y si no el nombre
    -- normalizado.
    entidad_key     TEXT NOT NULL,
    entidad_id      TEXT,
    entidad_nombre  TEXT NOT NULL DEFAULT '(sin nombre)',

    -- ── Jerarquía DESNORMALIZADA ────────────────────────────────
    -- Permite responder "gasto por campaña partiendo del nivel anuncio" con un
    -- GROUP BY, sin self-join, y reduce las 12 Maps de `CampaignIndex` a un
    -- SELECT DISTINCT.
    campana_id      TEXT,
    campana_nombre  TEXT,
    adset_id        TEXT,
    adset_nombre    TEXT,
    cuenta_id       TEXT,
    -- normLabel(entidad_nombre): la MISMA normalización que usan el motor y la
    -- UI (minúsculas, sin acentos, `_`/`-` como espacios). Guardarla permite
    -- hacer el cruce por nombre en SQL en vez de traerse las filas.
    nombre_norm     TEXT NOT NULL DEFAULT '',

    -- ── Métricas comunes a las dos plataformas ──────────────────
    spend           NUMERIC(14,4) NOT NULL DEFAULT 0,
    impressions     BIGINT  NOT NULL DEFAULT 0,
    clicks          BIGINT  NOT NULL DEFAULT 0,
    -- NO es aditivo entre entidades ni entre niveles: son personas únicas.
    reach           BIGINT  NOT NULL DEFAULT 0,
    link_clicks     BIGINT  NOT NULL DEFAULT 0,

    -- ── Eventos "calientes": columna propia porque se filtran y ordenan ──
    leads_form              BIGINT NOT NULL DEFAULT 0,
    purchases               BIGINT NOT NULL DEFAULT 0,
    landing_page_views      BIGINT NOT NULL DEFAULT 0,
    complete_registration   BIGINT NOT NULL DEFAULT 0,
    adds_to_cart            BIGINT NOT NULL DEFAULT 0,
    initiates_checkout      BIGINT NOT NULL DEFAULT 0,
    view_content            BIGINT NOT NULL DEFAULT 0,
    video_views             BIGINT NOT NULL DEFAULT 0,
    video_thruplay          BIGINT NOT NULL DEFAULT 0,
    post_engagement         BIGINT NOT NULL DEFAULT 0,
    messaging_conversations  BIGINT NOT NULL DEFAULT 0,
    -- Única métrica de conversión propia de TikTok.
    conversions             BIGINT NOT NULL DEFAULT 0,

    -- ── Cola larga ──────────────────────────────────────────────
    -- El resto de eventos de píxel (search, add_to_wishlist, contact, schedule,
    -- subscribe, start_trial, submit_application, page_engagement, post_saves,
    -- post_reactions, post_shares, post_comments, video_3s, results) y las
    -- conversiones personalizadas, que son por cliente y no pueden ser columnas.
    --   { "search": 12, "custom": { "lead_calificado": 3 } }
    -- SIN índice GIN a propósito: se lee por clave conocida, no se busca.
    eventos         JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- ── Trazabilidad ────────────────────────────────────────────
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 'worker' | 'backfill': permite auditar y re-backfillear sin pisar lo que
    -- escribe el worker en vivo.
    origen          TEXT NOT NULL DEFAULT 'worker',

    UNIQUE (cliente_id, fecha, plataforma, nivel, entidad_key)
);

-- ────────────────────────────────────────────────────────────────
-- Índices. Deliberadamente pocos: cada uno cuesta espacio real y el margen
-- contra el tope de 500 MB es lo que decide el alcance de esta migración.
-- ────────────────────────────────────────────────────────────────

-- Lectura principal del motor: cliente + nivel + rango de fechas.
CREATE INDEX IF NOT EXISTS idx_ads_daily_lectura
    ON public.ads_daily (cliente_id, nivel, fecha DESC);

-- Rollup a campaña desde niveles inferiores y desplegable de campañas.
CREATE INDEX IF NOT EXISTS idx_ads_daily_campana
    ON public.ads_daily (cliente_id, campana_id, fecha DESC)
    WHERE campana_id IS NOT NULL;

-- Cruce por NOMBRE: son 4 de los 7 pasos de la cascada de `matchToCampaign`.
CREATE INDEX IF NOT EXISTS idx_ads_daily_nombre_norm
    ON public.ads_daily (cliente_id, nivel, nombre_norm);

-- Cruce por ID: pasos 2 y 3 (utm_id = campaign_id | ad_id). Parcial porque
-- TikTok puede no traer id.
CREATE INDEX IF NOT EXISTS idx_ads_daily_entidad_id
    ON public.ads_daily (cliente_id, entidad_id)
    WHERE entidad_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────
-- Comentarios: son la documentación que sobrevive al repo.
-- ────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.ads_daily IS
    'Hechos de publicidad normalizados: una fila por (cliente, fecha, plataforma, NIVEL, entidad). Los niveles NO suman entre sí (dedup de atribución de Meta) y reach cuenta personas únicas: TODA lectura debe fijar `nivel`. Sumar sin filtrarlo triplica el gasto.';
COMMENT ON COLUMN public.ads_daily.entidad_key IS
    'entidad_id, o normLabel(entidad_nombre) si la plataforma no dio id. Es la clave del UNIQUE porque dos NULL no colisionan en un índice único y la entidad se duplicaría en cada sync.';
COMMENT ON COLUMN public.ads_daily.reach IS
    'Personas ÚNICAS. NO sumar entre entidades ni entre niveles.';
COMMENT ON COLUMN public.ads_daily.nombre_norm IS
    'normLabel(entidad_nombre): misma normalización que bi-metadata.normLabel, para poder cruzar por nombre en SQL.';
COMMENT ON COLUMN public.ads_daily.eventos IS
    'Cola larga de eventos de píxel y conversiones personalizadas. Sin índice GIN: se lee por clave conocida.';
COMMENT ON COLUMN public.ads_daily.origen IS
    'worker | backfill. Permite re-ejecutar el backfill sin pisar lo que el worker escribe en vivo.';

-- ────────────────────────────────────────────────────────────────
-- Retención del nivel ANUNCIO
--
-- Es el 65% de las filas (111.800 de 171.666) y lo que hace que la tabla no
-- quepa. Campaña y conjunto se conservan siempre: son los ejes con los que se
-- agrupan los informes, incluidos los antiguos. El desglose por anuncio de
-- fechas viejas sigue disponible en el JSONB de `metricas_diarias`.
--
-- No se programa desde aquí: lo llama el planificador del sync
-- (`src/lib/sync/planner.ts`), igual que la purga de `pixel_events`.
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purgar_ads_daily(p_dias INTEGER DEFAULT 30)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_borradas INTEGER;
BEGIN
    DELETE FROM public.ads_daily
     WHERE nivel = 'ad'
       AND fecha < CURRENT_DATE - p_dias;
    GET DIAGNOSTICS v_borradas = ROW_COUNT;
    RETURN v_borradas;
END;
$$;

COMMENT ON FUNCTION public.purgar_ads_daily(INTEGER) IS
    'Borra las filas de nivel anuncio de más de N días (30 por defecto). Campaña y conjunto NO se tocan. Necesario para que la tabla quepa en el tope de almacenamiento del plan.';

-- ────────────────────────────────────────────────────────────────
-- RLS
--
-- El módulo consulta con service role (`createAdminClient`), que salta RLS; se
-- habilita para que sea seguro si algún día se lee desde el cliente.
--
-- Se usa `public.is_superadmin()` (migración 041) en vez del correo cableado que
-- arrastran las políticas de las migraciones 023 y 058
-- (`auth.jwt() ->> 'email' = 'robinson@adshouse.com'`): esa forma deja de
-- funcionar en cuanto cambia la persona.
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.ads_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Clients view own ads_daily" ON public.ads_daily;
CREATE POLICY "Clients view own ads_daily" ON public.ads_daily
    FOR SELECT
    USING (cliente_id IN (SELECT id FROM public.clientes WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Admin full access ads_daily" ON public.ads_daily;
CREATE POLICY "Admin full access ads_daily" ON public.ads_daily
    FOR ALL
    USING (public.is_superadmin());
