-- migrations/053_snapshots.sql
-- Congelado de períodos cerrados.
--
-- Hoy un informe de marzo puede cambiar en julio: el worker re-descarga y
-- sobrescribe, Meta reatribuye conversiones hasta 28 días después, y un fallo
-- transitorio podía meter ceros. Para un cliente que ya recibió su informe
-- mensual, eso es inaceptable.
--
-- Política: el día 7 del mes siguiente se hace una re-descarga final con la
-- ventana de atribución completa (35 días) y el mes queda congelado.
--
-- Dos piezas complementarias:
--   • metricas_snapshots  → copia íntegra de las filas del mes (auditoría y
--                           restauración si alguien reabre y algo sale mal).
--   • periodos_cerrados   → el candado operativo que consulta el worker antes
--                           de sincronizar una fecha.

CREATE TABLE IF NOT EXISTS public.metricas_snapshots (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id    uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    -- Primer día del mes congelado (2026-03-01 = marzo de 2026).
    periodo       date NOT NULL,
    congelado_at  timestamptz NOT NULL DEFAULT now(),
    -- Copia de las filas de metricas_diarias del mes, tal cual estaban al cerrar.
    filas         jsonb NOT NULL,
    filas_count   int NOT NULL DEFAULT 0,
    checksum      text,
    UNIQUE (cliente_id, periodo)
);

COMMENT ON TABLE  public.metricas_snapshots IS 'Copia congelada de metricas_diarias por mes cerrado.';
COMMENT ON COLUMN public.metricas_snapshots.checksum IS 'Hash del contenido: detecta si las filas vivas divergen del snapshot.';

CREATE TABLE IF NOT EXISTS public.periodos_cerrados (
    cliente_id  uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    periodo     date NOT NULL,
    cerrado_at  timestamptz NOT NULL DEFAULT now(),
    cerrado_por text NOT NULL DEFAULT 'cron',
    PRIMARY KEY (cliente_id, periodo)
);

COMMENT ON TABLE public.periodos_cerrados IS 'Candado: el worker NO sincroniza fechas de estos meses. Reabrir = borrar la fila.';

CREATE INDEX IF NOT EXISTS idx_periodos_cerrados_periodo
    ON public.periodos_cerrados (periodo DESC);

ALTER TABLE public.metricas_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.periodos_cerrados  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "metricas_snapshots_read" ON public.metricas_snapshots;
CREATE POLICY "metricas_snapshots_read" ON public.metricas_snapshots
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "periodos_cerrados_read" ON public.periodos_cerrados;
CREATE POLICY "periodos_cerrados_read" ON public.periodos_cerrados
    FOR SELECT TO authenticated USING (true);
