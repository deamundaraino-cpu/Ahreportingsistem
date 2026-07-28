-- ════════════════════════════════════════════════════════════════
-- Migration 057: Filas crudas de Google Sheets
-- ════════════════════════════════════════════════════════════════
-- El sync pasa a traer TODAS las columnas de cada pestaña tal cual
-- (texto incluido), no solo las declaradas en `custom_columns`. Los
-- "campos" (migración 058) son una capa de definición ENCIMA de estos
-- datos: crear o editar un campo recalcula desde aquí, sin volver a
-- llamar a Google.
--
-- Por qué tabla nueva y no `conversiones_offline.custom_fields`:
--   1. `getDashboardData` lee `conversiones_offline` con select('*') en
--      cada carga de dashboard; un JSONB con la fila entera
--      multiplicaría el peso de esa consulta.
--   2. `conversiones_offline` descarta las filas con cantidad <= 0 (no
--      son conversiones), pero la capa cruda las necesita: una fila sin
--      cantidad sigue teniendo valores de campo.
--   3. Permite retirar el mapeo tipo/cantidad/valor de una pestaña sin
--      perder sus datos.
--
-- Aditivo: nada de lo existente cambia de contenido ni de forma.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.sheet_filas (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id     UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    -- id de la config de sheet (clientes.config_api.google_sheets_conversiones[].id),
    -- no el ID del documento de Google. Misma clave de partición que
    -- conversiones_offline.sheet_id.
    sheet_id       TEXT NOT NULL,
    tab_name       TEXT NOT NULL DEFAULT '',
    fecha          DATE NOT NULL,
    -- Nº de fila de datos dentro de la pestaña (1 = primera tras el
    -- encabezado). Solo trazabilidad para el panel de diagnóstico.
    fila_num       INTEGER,
    -- { <columna_sanitizada>: <texto tal cual del Sheet> }
    valores        JSONB NOT NULL DEFAULT '{}'::jsonb,
    sync_batch_id  UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.sheet_filas IS
    'Filas crudas de las pestañas sincronizadas. Fuente de verdad para recalcular los campos de Sheet sin volver a llamar a Google.';
COMMENT ON COLUMN public.sheet_filas.sheet_id IS
    'id de la config de sheet (clientes.config_api.google_sheets_conversiones[].id), no el ID del documento de Google.';
COMMENT ON COLUMN public.sheet_filas.valores IS
    'Valores de la fila por columna sanitizada, sin convertir. Las columnas listadas en tab.raw_exclude no se guardan.';

-- ────────────────────────────────────────────────────────────────
-- Índices
-- ────────────────────────────────────────────────────────────────

-- Lecturas por rango de fechas (recálculo de campos y camino fila a fila).
CREATE INDEX IF NOT EXISTS idx_sheet_filas_cliente_fecha
    ON public.sheet_filas (cliente_id, fecha DESC);

-- Replace por sheet: se inserta el lote nuevo y luego se borran los anteriores.
CREATE INDEX IF NOT EXISTS idx_sheet_filas_batch
    ON public.sheet_filas (cliente_id, sheet_id, sync_batch_id);

-- Filtro cruzado por valor de campo (valores @> '{"rango":"20-100"}').
-- jsonb_path_ops es bastante más compacto que el GIN por defecto y cubre @>,
-- que es el único operador que usa el motor.
CREATE INDEX IF NOT EXISTS idx_sheet_filas_valores
    ON public.sheet_filas USING GIN (valores jsonb_path_ops);

-- ────────────────────────────────────────────────────────────────
-- Mantenimiento: el full-replace diario genera muchas tuplas muertas.
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.sheet_filas SET (
    fillfactor = 90,
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_analyze_scale_factor = 0.02
);

-- ────────────────────────────────────────────────────────────────
-- RLS — mismo patrón que conversiones_offline (migración 023)
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.sheet_filas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Clients view own sheet_filas" ON public.sheet_filas;
CREATE POLICY "Clients view own sheet_filas"
    ON public.sheet_filas FOR SELECT
    USING (cliente_id IN (SELECT id FROM public.clientes WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Admin full access sheet_filas" ON public.sheet_filas;
CREATE POLICY "Admin full access sheet_filas"
    ON public.sheet_filas FOR ALL
    USING (auth.jwt() ->> 'email' = 'robinson@adshouse.com');

-- ────────────────────────────────────────────────────────────────
-- Nota: qué columnas se guardan se controla por pestaña desde
-- clientes.config_api.google_sheets_conversiones[].tabs[]:
--   raw_mode:    'all' (por defecto) | 'declared' | 'none'
--   raw_exclude: ["email", "telefono", ...]  columnas sanitizadas
--                que nunca se guardan (PII / alta cardinalidad).
-- ────────────────────────────────────────────────────────────────
