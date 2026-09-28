-- ════════════════════════════════════════════════════════════════
-- 097 · GA4 desglosado por fuente/medio/campaña y eventos clave
-- ════════════════════════════════════════════════════════════════
--
-- Hasta aquí GA4 entraba como TRES números por día para todo el sitio
-- (`metricas_diarias.ga_sessions`, `ga_bounce_rate`, `ga_avg_session_duration`):
-- solo cruzaba con el resto por fecha. Estas tablas guardan las sesiones y los
-- eventos clave por la tupla UTM de la sesión, en crudo, igual que los leads y
-- las ventas de Hotmart. La campaña se RESUELVE al consultar con el mismo
-- motor (`campaign-resolver.ts`): `utm_id` = id de campaña de Meta cruza
-- exacto, y las correcciones de /cruce-campanas aplican con efecto retroactivo.
--
-- Por qué dos tablas y no una con dos tipos de fila: `eventName` junto a
-- `sessions` da «sesiones en las que ocurrió el evento», que no es aditivo; en
-- tabla aparte no se puede sumar por error.
--
-- Vacíos: `''` y no NULL, para que el UNIQUE funcione (dos NULL no chocan).
-- `(not set)`, `(direct)`, `(organic)`… se normalizan a `''` en la ingesta.
--
-- Escritura: SOLO vía `ga4_reemplazar_rango` (una llamada = una transacción:
-- un fallo a mitad deja los datos anteriores intactos).
--
-- Reversión:
--   DROP FUNCTION IF EXISTS public.ga4_reemplazar_rango(UUID, DATE, DATE, JSONB, JSONB, JSONB);
--   DROP FUNCTION IF EXISTS public.ga4_sesiones_resumen(UUID, DATE, DATE, BOOLEAN);
--   DROP FUNCTION IF EXISTS public.ga4_eventos_resumen(UUID, DATE, DATE, TEXT[], BOOLEAN);
--   DROP TABLE IF EXISTS public.ga4_eventos_clave_diarios, public.ga4_sesiones_diarias, public.ga4_estado;
--   (y devolver el CHECK de sync_jobs a la lista de la 094)

-- ────────────────────────────────────────────────────────────────
-- 1) Sesiones por día × tupla UTM de la sesión
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ga4_sesiones_diarias (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    -- Día de la PROPIEDAD (dimensión `date` de GA4), como el gasto de Meta es
    -- el día de la cuenta. La zona de la propiedad queda en `ga4_estado`.
    fecha DATE NOT NULL,
    utm_source   TEXT NOT NULL DEFAULT '',   -- sessionSource
    utm_medium   TEXT NOT NULL DEFAULT '',   -- sessionMedium
    utm_campaign TEXT NOT NULL DEFAULT '',   -- sessionCampaignName
    utm_id       TEXT NOT NULL DEFAULT '',   -- sessionCampaignId (= utm_id)
    sesiones BIGINT NOT NULL DEFAULT 0,
    sesiones_interaccion BIGINT NOT NULL DEFAULT 0,   -- engagedSessions
    eventos_clave NUMERIC(14,2) NOT NULL DEFAULT 0,   -- keyEvents (todos)
    ingresos NUMERIC(14,4) NOT NULL DEFAULT 0,        -- totalRevenue, moneda de la propiedad
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ga4_sesiones_diarias_uniq
        UNIQUE (cliente_id, fecha, utm_source, utm_medium, utm_campaign, utm_id)
);

-- ────────────────────────────────────────────────────────────────
-- 2) Eventos clave por día × evento × tupla UTM (solo filas con > 0)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ga4_eventos_clave_diarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    evento TEXT NOT NULL,
    utm_source   TEXT NOT NULL DEFAULT '',
    utm_medium   TEXT NOT NULL DEFAULT '',
    utm_campaign TEXT NOT NULL DEFAULT '',
    utm_id       TEXT NOT NULL DEFAULT '',
    eventos_clave NUMERIC(14,2) NOT NULL DEFAULT 0,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ga4_eventos_clave_diarios_uniq
        UNIQUE (cliente_id, fecha, evento, utm_source, utm_medium, utm_campaign, utm_id)
);

-- ────────────────────────────────────────────────────────────────
-- 3) Estado por cliente: el error real, cobertura, metadatos de la propiedad
-- ────────────────────────────────────────────────────────────────
-- Antes el error de GA4 solo llegaba a un `log()` del worker: la única propiedad
-- configurada falló en cada sincronización durante meses sin que nadie lo viera.
CREATE TABLE IF NOT EXISTS public.ga4_estado (
    cliente_id UUID PRIMARY KEY REFERENCES public.clientes(id) ON DELETE CASCADE,
    propiedad TEXT,
    zona_horaria TEXT,
    moneda TEXT,
    cubierto_desde DATE,
    cubierto_hasta DATE,
    ultimo_ok_at TIMESTAMPTZ,
    ultimo_intento_at TIMESTAMPTZ,
    ultimo_error TEXT,
    ultimo_error_codigo TEXT,
    ultimo_error_at TIMESTAMPTZ,
    umbral BOOLEAN NOT NULL DEFAULT false,      -- subjectToThresholding
    fila_otros BOOLEAN NOT NULL DEFAULT false,  -- dataLossFromOtherRow
    muestreo BOOLEAN NOT NULL DEFAULT false,    -- samplingMetadatas no vacío
    cuota JSONB,
    -- {"purchase": "2026-09-27", ...}: evento → última fecha con eventos clave.
    eventos JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────────
-- 4) RLS (mismo patrón que ads_daily, migración 063)
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.ga4_sesiones_diarias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ga4_eventos_clave_diarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ga4_estado ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Clients view own ga4_sesiones_diarias" ON public.ga4_sesiones_diarias;
CREATE POLICY "Clients view own ga4_sesiones_diarias" ON public.ga4_sesiones_diarias
    FOR SELECT
    USING (cliente_id IN (SELECT id FROM public.clientes WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS "Admin full access ga4_sesiones_diarias" ON public.ga4_sesiones_diarias;
CREATE POLICY "Admin full access ga4_sesiones_diarias" ON public.ga4_sesiones_diarias
    FOR ALL
    USING (public.is_superadmin());

DROP POLICY IF EXISTS "Clients view own ga4_eventos_clave_diarios" ON public.ga4_eventos_clave_diarios;
CREATE POLICY "Clients view own ga4_eventos_clave_diarios" ON public.ga4_eventos_clave_diarios
    FOR SELECT
    USING (cliente_id IN (SELECT id FROM public.clientes WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS "Admin full access ga4_eventos_clave_diarios" ON public.ga4_eventos_clave_diarios;
CREATE POLICY "Admin full access ga4_eventos_clave_diarios" ON public.ga4_eventos_clave_diarios
    FOR ALL
    USING (public.is_superadmin());

DROP POLICY IF EXISTS "Clients view own ga4_estado" ON public.ga4_estado;
CREATE POLICY "Clients view own ga4_estado" ON public.ga4_estado
    FOR SELECT
    USING (cliente_id IN (SELECT id FROM public.clientes WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS "Admin full access ga4_estado" ON public.ga4_estado;
CREATE POLICY "Admin full access ga4_estado" ON public.ga4_estado
    FOR ALL
    USING (public.is_superadmin());

-- ────────────────────────────────────────────────────────────────
-- 5) Escritura atómica por rango
-- ────────────────────────────────────────────────────────────────
-- p_sesiones: [{fecha, utm_source, utm_medium, utm_campaign, utm_id, sesiones,
--               sesiones_interaccion, eventos_clave, ingresos}]
-- p_eventos:  [{fecha, evento, utm_source, utm_medium, utm_campaign, utm_id, eventos_clave}]
-- p_estado:   {propiedad, zona_horaria, moneda, umbral, fila_otros, muestreo, cuota}
CREATE OR REPLACE FUNCTION public.ga4_reemplazar_rango(
    p_cliente_id UUID,
    p_desde DATE,
    p_hasta DATE,
    p_sesiones JSONB,
    p_eventos JSONB,
    p_estado JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ses INT := 0;
    v_ev INT := 0;
    v_eventos JSONB;
BEGIN
    IF p_desde IS NULL OR p_hasta IS NULL OR p_hasta < p_desde THEN
        RAISE EXCEPTION 'ga4_reemplazar_rango: rango inválido % – %', p_desde, p_hasta;
    END IF;

    DELETE FROM public.ga4_sesiones_diarias
     WHERE cliente_id = p_cliente_id AND fecha BETWEEN p_desde AND p_hasta;
    DELETE FROM public.ga4_eventos_clave_diarios
     WHERE cliente_id = p_cliente_id AND fecha BETWEEN p_desde AND p_hasta;

    INSERT INTO public.ga4_sesiones_diarias AS t (
        cliente_id, fecha, utm_source, utm_medium, utm_campaign, utm_id,
        sesiones, sesiones_interaccion, eventos_clave, ingresos
    )
    SELECT p_cliente_id, r.fecha,
           COALESCE(r.utm_source, ''), COALESCE(r.utm_medium, ''),
           COALESCE(r.utm_campaign, ''), COALESCE(r.utm_id, ''),
           SUM(COALESCE(r.sesiones, 0)), SUM(COALESCE(r.sesiones_interaccion, 0)),
           SUM(COALESCE(r.eventos_clave, 0)), SUM(COALESCE(r.ingresos, 0))
      FROM jsonb_to_recordset(COALESCE(p_sesiones, '[]'::jsonb)) AS r(
           fecha DATE, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_id TEXT,
           sesiones BIGINT, sesiones_interaccion BIGINT, eventos_clave NUMERIC, ingresos NUMERIC)
     WHERE r.fecha BETWEEN p_desde AND p_hasta
     GROUP BY 1, 2, 3, 4, 5, 6;
    GET DIAGNOSTICS v_ses = ROW_COUNT;

    INSERT INTO public.ga4_eventos_clave_diarios (
        cliente_id, fecha, evento, utm_source, utm_medium, utm_campaign, utm_id, eventos_clave
    )
    SELECT p_cliente_id, r.fecha, r.evento,
           COALESCE(r.utm_source, ''), COALESCE(r.utm_medium, ''),
           COALESCE(r.utm_campaign, ''), COALESCE(r.utm_id, ''),
           SUM(COALESCE(r.eventos_clave, 0))
      FROM jsonb_to_recordset(COALESCE(p_eventos, '[]'::jsonb)) AS r(
           fecha DATE, evento TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
           utm_id TEXT, eventos_clave NUMERIC)
     WHERE r.fecha BETWEEN p_desde AND p_hasta AND COALESCE(r.evento, '') <> ''
     GROUP BY 1, 2, 3, 4, 5, 6, 7
    HAVING SUM(COALESCE(r.eventos_clave, 0)) > 0;
    GET DIAGNOSTICS v_ev = ROW_COUNT;

    -- Catálogo de eventos: evento → última fecha vista (se conserva lo anterior).
    SELECT COALESCE(jsonb_object_agg(evento, ultima), '{}'::jsonb) INTO v_eventos
      FROM (SELECT evento, MAX(fecha)::text AS ultima
              FROM public.ga4_eventos_clave_diarios
             WHERE cliente_id = p_cliente_id
             GROUP BY evento) e;

    INSERT INTO public.ga4_estado AS s (
        cliente_id, propiedad, zona_horaria, moneda, cubierto_desde, cubierto_hasta,
        ultimo_ok_at, ultimo_intento_at, ultimo_error, ultimo_error_codigo, ultimo_error_at,
        umbral, fila_otros, muestreo, cuota, eventos, updated_at
    ) VALUES (
        p_cliente_id, p_estado->>'propiedad', p_estado->>'zona_horaria', p_estado->>'moneda',
        p_desde, p_hasta, now(), now(), NULL, NULL, NULL,
        COALESCE((p_estado->>'umbral')::boolean, false),
        COALESCE((p_estado->>'fila_otros')::boolean, false),
        COALESCE((p_estado->>'muestreo')::boolean, false),
        p_estado->'cuota', v_eventos, now()
    )
    ON CONFLICT (cliente_id) DO UPDATE SET
        propiedad = EXCLUDED.propiedad,
        zona_horaria = COALESCE(EXCLUDED.zona_horaria, s.zona_horaria),
        moneda = COALESCE(EXCLUDED.moneda, s.moneda),
        cubierto_desde = LEAST(COALESCE(s.cubierto_desde, EXCLUDED.cubierto_desde), EXCLUDED.cubierto_desde),
        cubierto_hasta = GREATEST(COALESCE(s.cubierto_hasta, EXCLUDED.cubierto_hasta), EXCLUDED.cubierto_hasta),
        ultimo_ok_at = now(),
        ultimo_intento_at = now(),
        ultimo_error = NULL,
        ultimo_error_codigo = NULL,
        ultimo_error_at = NULL,
        umbral = EXCLUDED.umbral,
        fila_otros = EXCLUDED.fila_otros,
        muestreo = EXCLUDED.muestreo,
        cuota = COALESCE(EXCLUDED.cuota, s.cuota),
        eventos = EXCLUDED.eventos,
        updated_at = now();

    RETURN jsonb_build_object('sesiones', v_ses, 'eventos', v_ev);
END;
$$;

REVOKE ALL ON FUNCTION public.ga4_reemplazar_rango(UUID, DATE, DATE, JSONB, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ga4_reemplazar_rango(UUID, DATE, DATE, JSONB, JSONB, JSONB)
    TO service_role;

-- ────────────────────────────────────────────────────────────────
-- 6) Lectura agregada (el BI resuelve tuplas distintas, no filas diarias)
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ga4_sesiones_resumen(
    p_cliente_id UUID,
    p_desde DATE,
    p_hasta DATE,
    p_por_fecha BOOLEAN DEFAULT false
) RETURNS TABLE (
    fecha DATE, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_id TEXT,
    sesiones BIGINT, sesiones_interaccion BIGINT, eventos_clave NUMERIC, ingresos NUMERIC
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN p_por_fecha THEN s.fecha END,
           s.utm_source, s.utm_medium, s.utm_campaign, s.utm_id,
           SUM(s.sesiones)::bigint, SUM(s.sesiones_interaccion)::bigint,
           SUM(s.eventos_clave), SUM(s.ingresos)
      FROM public.ga4_sesiones_diarias s
     WHERE s.cliente_id = p_cliente_id AND s.fecha BETWEEN p_desde AND p_hasta
     GROUP BY 1, 2, 3, 4, 5
     -- Orden estable: el lector pagina con .range() (PostgREST corta en 1.000).
     ORDER BY 1, 2, 3, 4, 5
$$;

CREATE OR REPLACE FUNCTION public.ga4_eventos_resumen(
    p_cliente_id UUID,
    p_desde DATE,
    p_hasta DATE,
    p_eventos TEXT[],
    p_por_fecha BOOLEAN DEFAULT false
) RETURNS TABLE (
    fecha DATE, evento TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_id TEXT,
    eventos_clave NUMERIC
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN p_por_fecha THEN e.fecha END, e.evento,
           e.utm_source, e.utm_medium, e.utm_campaign, e.utm_id,
           SUM(e.eventos_clave)
      FROM public.ga4_eventos_clave_diarios e
     WHERE e.cliente_id = p_cliente_id AND e.fecha BETWEEN p_desde AND p_hasta
       AND (p_eventos IS NULL OR e.evento = ANY (p_eventos))
     GROUP BY 1, 2, 3, 4, 5, 6
     ORDER BY 1, 2, 3, 4, 5, 6
$$;

REVOKE ALL ON FUNCTION public.ga4_sesiones_resumen(UUID, DATE, DATE, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ga4_sesiones_resumen(UUID, DATE, DATE, BOOLEAN) TO service_role;
REVOKE ALL ON FUNCTION public.ga4_eventos_resumen(UUID, DATE, DATE, TEXT[], BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ga4_eventos_resumen(UUID, DATE, DATE, TEXT[], BOOLEAN) TO service_role;

-- ────────────────────────────────────────────────────────────────
-- 7) sync_jobs: tipo 'ga4'
-- ────────────────────────────────────────────────────────────────
-- Lista de la 094 (comprobada en producción el 2026-09-28) + 'ga4'. Va en la
-- misma migración que las tablas: no pueden existir unas sin el otro.
ALTER TABLE public.sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_tipo_check;
ALTER TABLE public.sync_jobs ADD CONSTRAINT sync_jobs_tipo_check CHECK (tipo = ANY (ARRAY[
    'metricas', 'sheets_leads', 'sheets_conversiones', 'meta_leads', 'utm_aggregate',
    'cierre_mes', 'reconciliar', 'hotmart_ventas', 'hotmart_reconciliar',
    'ghl_leads', 'ghl_oportunidades', 'tiktok_leads', 'ga4'
]::text[])) NOT VALID;
ALTER TABLE public.sync_jobs VALIDATE CONSTRAINT sync_jobs_tipo_check;

-- ────────────────────────────────────────────────────────────────
-- 8) Deriva de esquema: estas dos columnas existían en producción sin DDL
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.metricas_diarias ADD COLUMN IF NOT EXISTS ga_bounce_rate NUMERIC DEFAULT 0;
ALTER TABLE public.metricas_diarias ADD COLUMN IF NOT EXISTS ga_avg_session_duration NUMERIC DEFAULT 0;

NOTIFY pgrst, 'reload schema';
