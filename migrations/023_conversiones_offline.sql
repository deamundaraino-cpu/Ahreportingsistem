-- ════════════════════════════════════════════════════════════════
-- Migration 023: Conversiones Offline desde Google Sheets
-- ════════════════════════════════════════════════════════════════
-- Permite importar datos de conversiones no capturadas por píxel:
-- leads offline (WhatsApp, llamadas) y ventas cerradas manualmente.
-- El cliente llena un Google Sheet con columnas: fecha, tipo,
-- cantidad, valor, fuente, notas. El worker sincroniza cada día.
-- Configuración en clientes.config_api.google_sheets_conversiones.
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1. Tabla de registros individuales
--    Cada fila representa una entrada del Sheet del cliente.
--    Se hace full-replace por cliente en cada sync.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversiones_offline (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id    UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    fecha         DATE NOT NULL,
    tipo          TEXT NOT NULL DEFAULT 'otro',   -- 'lead' | 'venta' | 'otro' (libre)
    cantidad      INTEGER NOT NULL DEFAULT 0,
    valor         NUMERIC(12, 2),                 -- revenue, nulo si no aplica
    fuente        TEXT,
    notas         TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_offline_cliente_fecha
    ON public.conversiones_offline(cliente_id, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_conv_offline_tipo
    ON public.conversiones_offline(cliente_id, tipo, fecha DESC);

-- ────────────────────────────────────────────────────────────────
-- 2. Tabla de agregados diarios
--    Suma de cantidad y valor por cliente + fecha + tipo + fuente.
--    Usada por el dashboard para queries rápidas.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversiones_offline_diarias (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id       UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    fecha            DATE NOT NULL,
    tipo             TEXT NOT NULL DEFAULT 'otro',
    fuente           TEXT NOT NULL DEFAULT '',
    total_cantidad   INTEGER NOT NULL DEFAULT 0,
    total_valor      NUMERIC(12, 2) NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    UNIQUE (cliente_id, fecha, tipo, fuente)
);

CREATE INDEX IF NOT EXISTS idx_conv_offline_diarias_cliente_fecha
    ON public.conversiones_offline_diarias(cliente_id, fecha DESC);

-- ────────────────────────────────────────────────────────────────
-- 3. RLS — mismo patrón que leads / leads_diarios
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.conversiones_offline ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversiones_offline_diarias ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Clients view own conversiones_offline" ON public.conversiones_offline;
CREATE POLICY "Clients view own conversiones_offline"
    ON public.conversiones_offline FOR SELECT
    USING (cliente_id IN (SELECT id FROM public.clientes WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Admin full access conversiones_offline" ON public.conversiones_offline;
CREATE POLICY "Admin full access conversiones_offline"
    ON public.conversiones_offline FOR ALL
    USING (auth.jwt() ->> 'email' = 'robinson@adshouse.com');

DROP POLICY IF EXISTS "Clients view own conversiones_offline_diarias" ON public.conversiones_offline_diarias;
CREATE POLICY "Clients view own conversiones_offline_diarias"
    ON public.conversiones_offline_diarias FOR SELECT
    USING (cliente_id IN (SELECT id FROM public.clientes WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Admin full access conversiones_offline_diarias" ON public.conversiones_offline_diarias;
CREATE POLICY "Admin full access conversiones_offline_diarias"
    ON public.conversiones_offline_diarias FOR ALL
    USING (auth.jwt() ->> 'email' = 'robinson@adshouse.com');

-- ────────────────────────────────────────────────────────────────
-- Nota: la configuración se guarda en:
-- clientes.config_api -> google_sheets_conversiones (JSONB)
-- Estructura esperada:
-- {
--   "enabled": true,
--   "sheet_url": "https://docs.google.com/spreadsheets/d/...",
--   "sheet_name": "Conversiones",   -- opcional, usa primera hoja si vacío
--   "col_fecha": "fecha",           -- nombre de columna (default: fecha)
--   "col_tipo": "tipo",             -- (default: tipo)
--   "col_cantidad": "cantidad",     -- (default: cantidad)
--   "col_valor": "valor",           -- (default: valor)
--   "col_fuente": "fuente",         -- (default: fuente)
--   "col_notas": "notas"            -- (default: notas)
-- }
-- ────────────────────────────────────────────────────────────────
