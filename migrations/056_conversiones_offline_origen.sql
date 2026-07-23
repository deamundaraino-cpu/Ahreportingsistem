-- migrations/056_conversiones_offline_origen.sql
-- Trazabilidad de origen (sheet + pestaña) y log de calidad del sync de
-- conversiones offline.
--
-- Contexto: cada config de Google Sheet pasa a soportar VARIAS pestañas, cada
-- una con su propio mapeo de columnas. Dos cambios lo acompañan:
--
--   1. El full-replace deja de ser por cliente y pasa a ser por sheet. Antes, en
--      un sync con varios sheets, si uno fallaba el replace se hacía igual con
--      las filas de los que sí funcionaron → los datos del sheet fallido se
--      borraban en silencio.
--   2. Un log por sheet con las filas descartadas (fecha inválida, cantidad ≤ 0)
--      y los avisos por pestaña, para que la UI de settings los muestre en vez
--      de descartar filas sin decir nada.
--
-- Todo es aditivo: el código anterior sigue funcionando (inserta sin sheet_id).

-- ────────────────────────────────────────────────────────────────
-- 1. Origen de cada fila
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.conversiones_offline
    ADD COLUMN IF NOT EXISTS sheet_id TEXT,
    ADD COLUMN IF NOT EXISTS tab_name TEXT;

ALTER TABLE public.conversiones_offline_diarias
    ADD COLUMN IF NOT EXISTS sheet_id TEXT;

COMMENT ON COLUMN public.conversiones_offline.sheet_id IS 'id de la config de sheet (clientes.config_api.google_sheets_conversiones[].id), no el ID del documento de Google.';
COMMENT ON COLUMN public.conversiones_offline.tab_name IS 'Título de la pestaña del spreadsheet de la que proviene la fila.';
COMMENT ON COLUMN public.conversiones_offline_diarias.sheet_id IS 'Sheet de origen: los agregados se calculan y reemplazan por sheet.';

-- ────────────────────────────────────────────────────────────────
-- 2. El UNIQUE de agregados debe incluir el sheet
--    Con varios sheets, dos de ellos pueden aportar el mismo
--    (fecha, tipo, fuente) y el UNIQUE anterior lo rechazaba.
--    Se busca el constraint por sus columnas: el nombre autogenerado
--    puede diferir entre entornos.
-- ────────────────────────────────────────────────────────────────
DO $$
DECLARE
    cname TEXT;
BEGIN
    SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'conversiones_offline_diarias'
      AND con.contype = 'u'
      AND (
        SELECT array_agg(att.attname::text ORDER BY att.attname)
        FROM unnest(con.conkey) AS k(attnum)
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
      ) = ARRAY['cliente_id', 'fecha', 'fuente', 'tipo']
    LIMIT 1;

    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.conversiones_offline_diarias DROP CONSTRAINT %I', cname);
    END IF;
END $$;

-- Filas legacy con sheet_id NULL no colisionan (NULLs distintos); las retira el
-- primer sync posterior vía cleanupOrphanConversiones.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_diarias_origen
    ON public.conversiones_offline_diarias (cliente_id, sheet_id, fecha, tipo, fuente);

-- ────────────────────────────────────────────────────────────────
-- 3. Índices del replace por sheet
-- ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_conv_offline_sheet
    ON public.conversiones_offline (cliente_id, sheet_id, sync_batch_id);

CREATE INDEX IF NOT EXISTS idx_conv_diarias_sheet
    ON public.conversiones_offline_diarias (cliente_id, sheet_id, sync_batch_id);

-- ────────────────────────────────────────────────────────────────
-- 4. Log de calidad del sync (últimos 20 por cliente+sheet)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversiones_offline_sync_log (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id        UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    sheet_id          TEXT NOT NULL,
    run_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status            TEXT NOT NULL DEFAULT 'ok',   -- 'ok' | 'partial' | 'error'
    rows_ok           INTEGER NOT NULL DEFAULT 0,
    rows_descartadas  INTEGER NOT NULL DEFAULT 0,
    -- { por_pestana: [{ tab_name, rows_ok, fecha_invalida, cantidad_invalida, warnings[] }], error?: text }
    detalle           JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_conv_sync_log
    ON public.conversiones_offline_sync_log (cliente_id, sheet_id, run_at DESC);

ALTER TABLE public.conversiones_offline_sync_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin full access conversiones_offline_sync_log" ON public.conversiones_offline_sync_log;
CREATE POLICY "Admin full access conversiones_offline_sync_log"
    ON public.conversiones_offline_sync_log FOR ALL
    USING (auth.jwt() ->> 'email' = 'robinson@adshouse.com');
