-- ════════════════════════════════════════════════════════════════
-- Migration 058: Campos de Sheet (definición + desglose diario)
-- ════════════════════════════════════════════════════════════════
-- Un "campo" es una definición POR CLIENTE que unifica columnas
-- equivalentes de VARIAS pestañas bajo un nombre visible único, con un
-- mapa de normalización de valores y una agregación. Resuelve el caso
-- real: la misma pregunta se llama "rango de ingresos" en un formulario
-- y "cuál es tu rango de ingresos" en otro, y sus valores se escriben
-- "20 a 100" en una hoja y "20-100" en la otra.
--
-- Por qué tabla propia y no clientes.config_api:
--   • `clientes` se lee entero (select('*')) en cada carga de dashboard
--     y en varios workers; el mapa de valores puede tener cientos de
--     entradas por campo.
--   • los tokens guardados en bi_reports / layouts apuntan a `clave`,
--     que necesita unicidad real y updated_at propio.
--
-- La CONEXIÓN (sheets, pestañas, columna de fecha, mapeo base
-- tipo/cantidad/valor) sigue viviendo en
-- clientes.config_api.google_sheets_conversiones: cero migración de
-- JSONB en producción.
--
-- Depende de la migración 057 (public.sheet_filas), que es la capa
-- cruda desde la que se recalcula todo esto.
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1. Definición del campo
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sheet_campos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id      UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    -- Slug estable [a-z0-9_]: es la parte pública de los tokens
    -- (sheetdim:<clave>, sheetagg:<agg>:<clave>, sf_<clave>). Renombrar
    -- el `nombre` no toca la clave, así que los informes no se rompen.
    clave           TEXT NOT NULL,
    -- Nombre visible: el que se ve en el BI, en el Layout Builder y en
    -- las tablas. Libre y renombrable.
    nombre          TEXT NOT NULL,
    descripcion     TEXT,
    -- 'dimension' = texto/categoría (agrupar y filtrar por él)
    -- 'metrica'   = numérico (sumar/promediar)
    -- 'ambos'     = las dos cosas
    rol             TEXT NOT NULL DEFAULT 'dimension'
                    CHECK (rol IN ('dimension', 'metrica', 'ambos')),
    formato         TEXT NOT NULL DEFAULT 'number'
                    CHECK (formato IN ('number', 'currency', 'percent', 'text')),
    -- Agregación por defecto de la métrica del campo.
    agregacion      TEXT NOT NULL DEFAULT 'count'
                    CHECK (agregacion IN ('count', 'sum', 'avg', 'min', 'max')),
    -- De dónde sale el dato. Un elemento por origen:
    -- [{ "sheet_id": "*"|uuid, "tab_name": "*"|titulo,
    --    "columnas": ["rango_de_ingresos"],
    --    "combinar": "primero"|"suma"|"concat" }]
    origenes        JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Normalización de valores: { <valor crudo normalizado>: <bucket> }
    -- Ej: { "20 a 100": "20-100", "20-100": "20-100", "20a100": "20-100" }
    valores_map     JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Orden de presentación de los buckets en gráficas y selectores.
    valores_orden   TEXT[] NOT NULL DEFAULT '{}',
    -- Qué hacer con un valor que no está en el mapa.
    sin_mapear      TEXT NOT NULL DEFAULT 'crudo'
                    CHECK (sin_mapear IN ('crudo', 'otros', 'ignorar')),
    -- Tope de buckets distintos. Superarlo marca el campo como de alta
    -- cardinalidad: sigue sirviendo como métrica agregada, pero deja de
    -- ofrecerse como dimensión y el excedente cae en '(otros)'.
    max_valores     INTEGER NOT NULL DEFAULT 200,
    alta_cardinalidad BOOLEAN NOT NULL DEFAULT FALSE,
    -- Compatibilidad: clave equivalente en
    -- conversiones_offline_diarias.custom_fields, para no ofrecer dos
    -- veces la misma columna cuando ya existía como offfield:<tipo>:<clave>.
    legacy_offfield TEXT,
    activo          BOOLEAN NOT NULL DEFAULT TRUE,
    orden           INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recalculado_at  TIMESTAMPTZ,
    UNIQUE (cliente_id, clave)
);

CREATE INDEX IF NOT EXISTS idx_sheet_campos_cliente
    ON public.sheet_campos (cliente_id, activo, orden);

COMMENT ON COLUMN public.sheet_campos.clave IS
    'Slug inmutable tras el alta: es la parte pública de los tokens guardados en bi_reports y en los layouts.';
COMMENT ON COLUMN public.sheet_campos.origenes IS
    'Mapeo N pestañas -> 1..N columnas equivalentes. sheet_id/tab_name aceptan "*" como comodín.';

-- ────────────────────────────────────────────────────────────────
-- 2. Vistas guardadas
--    "Leads 20-100" = contar filas donde el campo esté en (20-100).
--    Se comportan como una métrica más, sumable si la agregación lo es.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sheet_campo_vistas (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id  UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    campo_id    UUID NOT NULL REFERENCES public.sheet_campos(id) ON DELETE CASCADE,
    clave       TEXT NOT NULL,      -- token: sheetview:<clave> / sv_<clave>
    nombre      TEXT NOT NULL,
    agregacion  TEXT NOT NULL DEFAULT 'count'
                CHECK (agregacion IN ('count', 'sum', 'avg', 'min', 'max')),
    operador    TEXT NOT NULL DEFAULT 'in' CHECK (operador IN ('in', 'not_in')),
    valores     TEXT[] NOT NULL DEFAULT '{}',   -- buckets ya normalizados
    formato     TEXT NOT NULL DEFAULT 'number'
                CHECK (formato IN ('number', 'currency', 'percent')),
    activo      BOOLEAN NOT NULL DEFAULT TRUE,
    orden       INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (cliente_id, clave)
);

CREATE INDEX IF NOT EXISTS idx_sheet_campo_vistas_campo
    ON public.sheet_campo_vistas (campo_id, activo);

-- ────────────────────────────────────────────────────────────────
-- 3. Catálogo de valores CRUDOS detectados
--    Alimenta la UI de agrupación sin escanear sheet_filas cada vez que
--    se abre el editor. Se reescribe en cada recálculo del campo.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sheet_campo_valores (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id   UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    campo_id     UUID NOT NULL REFERENCES public.sheet_campos(id) ON DELETE CASCADE,
    valor_crudo  TEXT NOT NULL,
    valor_norm   TEXT NOT NULL,    -- bucket resultante tras valores_map
    filas        INTEGER NOT NULL DEFAULT 0,
    -- Pestañas donde aparece, para que la UI explique de dónde sale.
    origenes     TEXT[] NOT NULL DEFAULT '{}',
    ultima_fecha DATE,
    UNIQUE (campo_id, valor_crudo)
);

CREATE INDEX IF NOT EXISTS idx_sheet_campo_valores_campo
    ON public.sheet_campo_valores (campo_id, filas DESC);

-- ────────────────────────────────────────────────────────────────
-- 4. DESGLOSE DIARIO POR VALOR — el corazón del módulo
--
--    Grano: (cliente, campo, fecha, bucket). Es 100% derivable de
--    sheet_filas + sheet_campos, así que el replace es por CAMPO
--    (delete where campo_id + insert), no por sheet: editar un campo
--    recalcula solo lo suyo y en un instante.
--
--    `suma` y `n_num` se guardan por separado a propósito: con ambos, un
--    promedio agrega correctamente a CUALQUIER grano
--    (sum(suma)/sum(n_num)). Es lo que hoy no ocurre con las columnas de
--    tipo percentage, que se promedian ponderando por `cantidad` al
--    sincronizar y se vuelven a promediar al consultarlas — un promedio
--    de promedios.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sheet_campo_valores_diarios (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id  UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    campo_id    UUID NOT NULL REFERENCES public.sheet_campos(id) ON DELETE CASCADE,
    fecha       DATE NOT NULL,
    -- Bucket normalizado. Un campo puramente numérico sin desglose usa
    -- el bucket único '(total)' → una fila por día.
    valor       TEXT NOT NULL DEFAULT '(total)',
    filas       INTEGER NOT NULL DEFAULT 0,           -- conteo de filas
    suma        NUMERIC(18, 4) NOT NULL DEFAULT 0,    -- numerador
    n_num       INTEGER NOT NULL DEFAULT 0,           -- denominador de avg
    minimo      NUMERIC(18, 4),
    maximo      NUMERIC(18, 4),
    UNIQUE (campo_id, fecha, valor)
);

CREATE INDEX IF NOT EXISTS idx_scvd_cliente_fecha
    ON public.sheet_campo_valores_diarios (cliente_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_scvd_campo_fecha
    ON public.sheet_campo_valores_diarios (campo_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_scvd_campo_valor
    ON public.sheet_campo_valores_diarios (campo_id, valor);

COMMENT ON TABLE public.sheet_campo_valores_diarios IS
    'Desglose diario por valor de cada campo de Sheet. Derivado de sheet_filas: se puede reconstruir entero con recalcularCamposCliente.';

-- ────────────────────────────────────────────────────────────────
-- 5. updated_at automático
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sheet_campos_updated ON public.sheet_campos;
CREATE TRIGGER trg_sheet_campos_updated
    BEFORE UPDATE ON public.sheet_campos
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_sheet_campo_vistas_updated ON public.sheet_campo_vistas;
CREATE TRIGGER trg_sheet_campo_vistas_updated
    BEFORE UPDATE ON public.sheet_campo_vistas
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────
-- 6. RLS — mismo patrón que conversiones_offline (migración 023)
-- ────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sheet_campos', 'sheet_campo_vistas',
                           'sheet_campo_valores', 'sheet_campo_valores_diarios']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS "Clients view own %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Clients view own %1$s" ON public.%1$I FOR SELECT '
      'USING (cliente_id IN (SELECT id FROM public.clientes WHERE user_id = auth.uid()))', t);

    EXECUTE format('DROP POLICY IF EXISTS "Admin full access %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Admin full access %1$s" ON public.%1$I FOR ALL '
      'USING (auth.jwt() ->> ''email'' = ''robinson@adshouse.com'')', t);
  END LOOP;
END $$;
