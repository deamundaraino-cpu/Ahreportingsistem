-- migrations/052_metricas_freshness.sql
-- Marcas de frescura por fila y por fuente en metricas_diarias.
--
-- `created_at` solo se fijaba al insertar, así que era imposible saber cuándo se
-- refrescó por última vez una fila: el dashboard no podía decir si los números
-- eran de hace 10 minutos o de hace una semana.
--
--  • synced_at        → última vez que el worker verificó la fila (cambiara o no).
--  • source_synced_at → última verificación EXITOSA por fuente. Si Meta funcionó
--                       pero Hotmart falló, solo avanza la clave "meta". Permite
--                       mostrar "Hotmart desactualizado hace 2 días" en la UI.
--  • is_partial       → la fecha es HOY en hora Colombia: el día no ha cerrado,
--                       Meta sigue reatribuyendo y las cifras van a cambiar.

ALTER TABLE public.metricas_diarias
    ADD COLUMN IF NOT EXISTS synced_at        timestamptz,
    ADD COLUMN IF NOT EXISTS source_synced_at jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS is_partial       boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.metricas_diarias.synced_at IS 'Última verificación del worker (aunque el dato no cambiara).';
COMMENT ON COLUMN public.metricas_diarias.source_synced_at IS 'Última verificación exitosa por fuente: {"meta":ts,"tiktok":ts,"hotmart":ts,"ga4":ts}.';
COMMENT ON COLUMN public.metricas_diarias.is_partial IS 'true = día en curso, cifras aún no definitivas.';

-- Semilla razonable para las filas existentes: se sincronizaron al crearse.
UPDATE public.metricas_diarias
SET synced_at = created_at
WHERE synced_at IS NULL AND created_at IS NOT NULL;

-- El dashboard consulta el máximo synced_at por cliente en cada carga.
CREATE INDEX IF NOT EXISTS idx_metricas_diarias_cliente_synced
    ON public.metricas_diarias (cliente_id, synced_at DESC);
