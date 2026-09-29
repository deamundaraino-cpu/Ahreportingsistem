-- ════════════════════════════════════════════════════════════════
-- 100 · GA4 por página: sesiones por página de entrada y vistas por página
-- ════════════════════════════════════════════════════════════════
--
-- La 097 trae GA4 por la tupla UTM de la sesión, sin página. Esta añade:
--
--   · `ga4_landing_diarios`: sesiones, interacción, eventos clave, ingresos y
--     visitantes por día × PÁGINA DE ENTRADA (`landingPage`) × tupla UTM. Es lo
--     que permite «sesiones → leads por landing» junto a los leads por página.
--   · `ga4_vistas_diarias`: vistas (`screenPageViews`) por día × host × página:
--     el consumo de contenido de todo el sitio, como el informe «Páginas» de GA4.
--
-- Tablas APARTE y no una columna más en `ga4_sesiones_diarias`: cambiar aquella
-- obligaba a rehacer su UNIQUE y sus tres RPC (sobrecargas → 42725) y a volver a
-- descargar todo; además, los umbrales de GA4 en el informe más fino podrían
-- mover totales por campaña ya entregados. Así las lecturas por campaña siguen
-- exactamente igual y las páginas llevan su propia cobertura en `ga4_estado`.
--
-- La ruta de la página se guarda YA NORMALIZADA (`rutaDePagina` en
-- `src/lib/report-utm/page-url.ts`): sin host, query, fragmento ni barra final
-- y en minúsculas, igual que se normaliza `lead_events.page_url` al agrupar.
--
-- Solo añade: se puede aplicar antes de desplegar el código.
--
-- Reversión:
--   DROP FUNCTION IF EXISTS public.ga4_reemplazar_paginas(UUID, DATE, DATE, JSONB, JSONB, JSONB);
--   DROP FUNCTION IF EXISTS public.ga4_landing_resumen(UUID, DATE, DATE, BOOLEAN);
--   DROP FUNCTION IF EXISTS public.ga4_vistas_resumen(UUID, DATE, DATE, BOOLEAN);
--   DROP FUNCTION IF EXISTS report_utm.bi_valores_pagina(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT, BOOLEAN);
--   DROP TABLE IF EXISTS public.ga4_landing_diarios, public.ga4_vistas_diarias;
--   ALTER TABLE public.ga4_estado DROP COLUMN IF EXISTS paginas_cubierto_desde, … (las 7 paginas_*);

-- ────────────────────────────────────────────────────────────────
-- 1) Sesiones por página de entrada × tupla UTM
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ga4_landing_diarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    landing      TEXT NOT NULL DEFAULT '',   -- ruta normalizada; '' = (not set)
    utm_source   TEXT NOT NULL DEFAULT '',
    utm_medium   TEXT NOT NULL DEFAULT '',
    utm_campaign TEXT NOT NULL DEFAULT '',
    utm_id       TEXT NOT NULL DEFAULT '',
    sesiones BIGINT NOT NULL DEFAULT 0,
    sesiones_interaccion BIGINT NOT NULL DEFAULT 0,
    eventos_clave NUMERIC(14,2) NOT NULL DEFAULT 0,
    ingresos NUMERIC(14,4) NOT NULL DEFAULT 0,
    -- totalUsers del día para esa tupla. NO aditivo entre días ni entre filas:
    -- quien vuelve otro día cuenta dos veces. El BI lo rotula «suma diaria».
    visitantes BIGINT NOT NULL DEFAULT 0,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ga4_landing_diarios_uniq
        UNIQUE (cliente_id, fecha, landing, utm_source, utm_medium, utm_campaign, utm_id)
);

-- ────────────────────────────────────────────────────────────────
-- 2) Vistas por página
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ga4_vistas_diarias (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    -- Se guarda aunque el BI sume entre hosts: un cliente con dos dominios
    -- podrá separarlos sin volver a descargar.
    host   TEXT NOT NULL DEFAULT '',
    pagina TEXT NOT NULL DEFAULT '',
    vistas BIGINT NOT NULL DEFAULT 0,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ga4_vistas_diarias_uniq UNIQUE (cliente_id, fecha, host, pagina)
);

-- ────────────────────────────────────────────────────────────────
-- 3) Estado propio de las páginas (no toca las flags de campaña)
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.ga4_estado ADD COLUMN IF NOT EXISTS paginas_cubierto_desde DATE;
ALTER TABLE public.ga4_estado ADD COLUMN IF NOT EXISTS paginas_cubierto_hasta DATE;
ALTER TABLE public.ga4_estado ADD COLUMN IF NOT EXISTS paginas_ultimo_ok_at TIMESTAMPTZ;
ALTER TABLE public.ga4_estado ADD COLUMN IF NOT EXISTS paginas_ultimo_error TEXT;
ALTER TABLE public.ga4_estado ADD COLUMN IF NOT EXISTS paginas_ultimo_error_at TIMESTAMPTZ;
ALTER TABLE public.ga4_estado ADD COLUMN IF NOT EXISTS paginas_umbral BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.ga4_estado ADD COLUMN IF NOT EXISTS paginas_fila_otros BOOLEAN NOT NULL DEFAULT false;

-- ────────────────────────────────────────────────────────────────
-- 4) RLS (patrón de la 098)
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.ga4_landing_diarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ga4_vistas_diarias ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Clients view own ga4_landing_diarios" ON public.ga4_landing_diarios;
CREATE POLICY "Clients view own ga4_landing_diarios" ON public.ga4_landing_diarios
    FOR SELECT USING (public.puede_ver_cliente(cliente_id));
DROP POLICY IF EXISTS "Admin full access ga4_landing_diarios" ON public.ga4_landing_diarios;
CREATE POLICY "Admin full access ga4_landing_diarios" ON public.ga4_landing_diarios
    FOR ALL USING (public.is_superadmin());

DROP POLICY IF EXISTS "Clients view own ga4_vistas_diarias" ON public.ga4_vistas_diarias;
CREATE POLICY "Clients view own ga4_vistas_diarias" ON public.ga4_vistas_diarias
    FOR SELECT USING (public.puede_ver_cliente(cliente_id));
DROP POLICY IF EXISTS "Admin full access ga4_vistas_diarias" ON public.ga4_vistas_diarias;
CREATE POLICY "Admin full access ga4_vistas_diarias" ON public.ga4_vistas_diarias
    FOR ALL USING (public.is_superadmin());

-- ────────────────────────────────────────────────────────────────
-- 5) Escritura atómica por rango
-- ────────────────────────────────────────────────────────────────
-- p_landing: [{fecha, landing, utm_source, utm_medium, utm_campaign, utm_id,
--              sesiones, sesiones_interaccion, eventos_clave, ingresos, visitantes}]
-- p_vistas:  [{fecha, host, pagina, vistas}]
-- p_estado:  {umbral, fila_otros}
-- Un argumento NULL deja ESA tabla intacta: si solo uno de los dos informes
-- respondió, se escribe el otro sin borrar lo guardado del que falló.
CREATE OR REPLACE FUNCTION public.ga4_reemplazar_paginas(
    p_cliente_id UUID,
    p_desde DATE,
    p_hasta DATE,
    p_landing JSONB,
    p_vistas JSONB,
    p_estado JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_landing INT := 0;
    v_vistas INT := 0;
BEGIN
    IF p_desde IS NULL OR p_hasta IS NULL OR p_hasta < p_desde THEN
        RAISE EXCEPTION 'ga4_reemplazar_paginas: rango inválido % – %', p_desde, p_hasta;
    END IF;

    IF p_landing IS NOT NULL THEN
        DELETE FROM public.ga4_landing_diarios
         WHERE cliente_id = p_cliente_id AND fecha BETWEEN p_desde AND p_hasta;
        INSERT INTO public.ga4_landing_diarios (
            cliente_id, fecha, landing, utm_source, utm_medium, utm_campaign, utm_id,
            sesiones, sesiones_interaccion, eventos_clave, ingresos, visitantes
        )
        SELECT p_cliente_id, r.fecha, COALESCE(r.landing, ''),
               COALESCE(r.utm_source, ''), COALESCE(r.utm_medium, ''),
               COALESCE(r.utm_campaign, ''), COALESCE(r.utm_id, ''),
               SUM(COALESCE(r.sesiones, 0)), SUM(COALESCE(r.sesiones_interaccion, 0)),
               SUM(COALESCE(r.eventos_clave, 0)), SUM(COALESCE(r.ingresos, 0)),
               SUM(COALESCE(r.visitantes, 0))
          FROM jsonb_to_recordset(p_landing) AS r(
               fecha DATE, landing TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
               utm_id TEXT, sesiones BIGINT, sesiones_interaccion BIGINT,
               eventos_clave NUMERIC, ingresos NUMERIC, visitantes BIGINT)
         WHERE r.fecha BETWEEN p_desde AND p_hasta
         GROUP BY 1, 2, 3, 4, 5, 6, 7;
        GET DIAGNOSTICS v_landing = ROW_COUNT;
    END IF;

    IF p_vistas IS NOT NULL THEN
        DELETE FROM public.ga4_vistas_diarias
         WHERE cliente_id = p_cliente_id AND fecha BETWEEN p_desde AND p_hasta;
        INSERT INTO public.ga4_vistas_diarias (cliente_id, fecha, host, pagina, vistas)
        SELECT p_cliente_id, r.fecha, COALESCE(r.host, ''), COALESCE(r.pagina, ''),
               SUM(COALESCE(r.vistas, 0))
          FROM jsonb_to_recordset(p_vistas) AS r(fecha DATE, host TEXT, pagina TEXT, vistas BIGINT)
         WHERE r.fecha BETWEEN p_desde AND p_hasta
         GROUP BY 1, 2, 3, 4;
        GET DIAGNOSTICS v_vistas = ROW_COUNT;
    END IF;

    -- Cobertura y flags propias. Solo si se escribió algo: una llamada con los
    -- dos informes fallidos no debe dar las páginas por sincronizadas.
    IF p_landing IS NOT NULL OR p_vistas IS NOT NULL THEN
        INSERT INTO public.ga4_estado AS s (
            cliente_id, paginas_cubierto_desde, paginas_cubierto_hasta, paginas_ultimo_ok_at,
            paginas_ultimo_error, paginas_ultimo_error_at, paginas_umbral, paginas_fila_otros,
            updated_at
        ) VALUES (
            p_cliente_id, p_desde, p_hasta, now(),
            CASE WHEN p_landing IS NULL OR p_vistas IS NULL THEN p_estado->>'error' END,
            CASE WHEN p_landing IS NULL OR p_vistas IS NULL THEN now() END,
            COALESCE((p_estado->>'umbral')::boolean, false),
            COALESCE((p_estado->>'fila_otros')::boolean, false),
            now()
        )
        ON CONFLICT (cliente_id) DO UPDATE SET
            paginas_cubierto_desde = LEAST(COALESCE(s.paginas_cubierto_desde, EXCLUDED.paginas_cubierto_desde), EXCLUDED.paginas_cubierto_desde),
            paginas_cubierto_hasta = GREATEST(COALESCE(s.paginas_cubierto_hasta, EXCLUDED.paginas_cubierto_hasta), EXCLUDED.paginas_cubierto_hasta),
            paginas_ultimo_ok_at = now(),
            paginas_ultimo_error = EXCLUDED.paginas_ultimo_error,
            paginas_ultimo_error_at = EXCLUDED.paginas_ultimo_error_at,
            paginas_umbral = EXCLUDED.paginas_umbral,
            paginas_fila_otros = EXCLUDED.paginas_fila_otros,
            updated_at = now();
    END IF;

    RETURN jsonb_build_object('landing', v_landing, 'vistas', v_vistas);
END;
$$;

REVOKE ALL ON FUNCTION public.ga4_reemplazar_paginas(UUID, DATE, DATE, JSONB, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ga4_reemplazar_paginas(UUID, DATE, DATE, JSONB, JSONB, JSONB)
    TO service_role;

-- ────────────────────────────────────────────────────────────────
-- 6) Lectura agregada (orden estable: el lector pagina con .range())
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ga4_landing_resumen(
    p_cliente_id UUID,
    p_desde DATE,
    p_hasta DATE,
    p_por_fecha BOOLEAN DEFAULT false
) RETURNS TABLE (
    fecha DATE, landing TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_id TEXT,
    sesiones BIGINT, sesiones_interaccion BIGINT, eventos_clave NUMERIC, ingresos NUMERIC,
    visitantes BIGINT
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN p_por_fecha THEN l.fecha END, l.landing,
           l.utm_source, l.utm_medium, l.utm_campaign, l.utm_id,
           SUM(l.sesiones)::bigint, SUM(l.sesiones_interaccion)::bigint,
           SUM(l.eventos_clave), SUM(l.ingresos), SUM(l.visitantes)::bigint
      FROM public.ga4_landing_diarios l
     WHERE l.cliente_id = p_cliente_id AND l.fecha BETWEEN p_desde AND p_hasta
     GROUP BY 1, 2, 3, 4, 5, 6
     ORDER BY 1, 2, 3, 4, 5, 6
$$;

CREATE OR REPLACE FUNCTION public.ga4_vistas_resumen(
    p_cliente_id UUID,
    p_desde DATE,
    p_hasta DATE,
    p_por_fecha BOOLEAN DEFAULT false
) RETURNS TABLE (fecha DATE, pagina TEXT, vistas BIGINT)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN p_por_fecha THEN v.fecha END, v.pagina, SUM(v.vistas)::bigint
      FROM public.ga4_vistas_diarias v
     WHERE v.cliente_id = p_cliente_id AND v.fecha BETWEEN p_desde AND p_hasta
     GROUP BY 1, 2
     ORDER BY 1, 2
$$;

REVOKE ALL ON FUNCTION public.ga4_landing_resumen(UUID, DATE, DATE, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ga4_landing_resumen(UUID, DATE, DATE, BOOLEAN) TO service_role;
REVOKE ALL ON FUNCTION public.ga4_vistas_resumen(UUID, DATE, DATE, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ga4_vistas_resumen(UUID, DATE, DATE, BOOLEAN) TO service_role;

-- ────────────────────────────────────────────────────────────────
-- 7) Valores del filtro «Página de entrada» de los leads
-- ────────────────────────────────────────────────────────────────
-- Agrupa `page_url` sin query ni fragmento en SQL (Eduversio: 38.000 URL para 19
-- rutas por los `fbclid`), y el resto de la normalización la hace TypeScript con
-- `rutaDePagina`: así no hay dos copias de la regla que mantener iguales.
CREATE OR REPLACE FUNCTION report_utm.bi_valores_pagina(
    p_cliente_id UUID,
    p_desde TIMESTAMPTZ,
    p_hasta TIMESTAMPTZ,
    p_limite INT DEFAULT 5000,
    p_incluir_excluidos BOOLEAN DEFAULT false
) RETURNS TABLE (url_base TEXT, n BIGINT)
LANGUAGE sql STABLE
SET search_path = report_utm, public, pg_temp
AS $$
    SELECT split_part(split_part(e.page_url, '?', 1), '#', 1) AS url_base, COUNT(*)::bigint
      FROM report_utm.lead_events e
     WHERE e.cliente_id = p_cliente_id
       AND e.created_at >= p_desde AND e.created_at < p_hasta
       AND e.page_url IS NOT NULL
       AND (p_incluir_excluidos OR NOT e.excluido)
     GROUP BY 1
     ORDER BY 2 DESC, 1
     LIMIT GREATEST(1, LEAST(p_limite, 20000))
$$;

REVOKE ALL ON FUNCTION report_utm.bi_valores_pagina(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_utm.bi_valores_pagina(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT, BOOLEAN)
    TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
