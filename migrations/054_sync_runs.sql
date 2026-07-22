-- migrations/054_sync_runs.sql
-- Historial persistente de ejecuciones de sincronización.
--
-- Hasta ahora los `debugLogs` del worker solo viajaban en la respuesta HTTP del
-- cron: si nadie miraba esa respuesta (que es lo normal en un cron), no quedaba
-- ningún rastro de qué pasó. Un cliente con Hotmart caído tres días seguidos era
-- indistinguible de un cliente sin ventas.
--
-- Retención: 30 días (la limpia el planner diario).

CREATE TABLE IF NOT EXISTS public.sync_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id         uuid REFERENCES public.sync_jobs(id) ON DELETE SET NULL,
    tipo           text NOT NULL,
    cliente_id     uuid REFERENCES public.clientes(id) ON DELETE CASCADE,
    fecha_inicio   date,
    fecha_fin      date,
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,
    duracion_ms    int,
    estado         text NOT NULL DEFAULT 'running'
                       CHECK (estado IN ('running', 'ok', 'partial', 'error')),
    filas_escritas int NOT NULL DEFAULT 0,
    filas_saltadas int NOT NULL DEFAULT 0,
    -- Resultado por fuente: {"meta":{"ok":true,"rows":7},"hotmart":{"ok":false,"error":"401"}}
    stats          jsonb NOT NULL DEFAULT '{}'::jsonb,
    error          text,
    -- debugLogs truncados (~200 entradas) para diagnosticar sin abrir el código.
    logs           jsonb NOT NULL DEFAULT '[]'::jsonb,
    ejecutor       text NOT NULL DEFAULT 'vercel'
);

COMMENT ON TABLE  public.sync_runs IS 'Una fila por unidad de sync ejecutada. Alimenta el panel /admin/sync.';
COMMENT ON COLUMN public.sync_runs.ejecutor IS 'vercel | vps — de dónde salió la ejecución.';

CREATE INDEX IF NOT EXISTS idx_sync_runs_cliente_started
    ON public.sync_runs (cliente_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started
    ON public.sync_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_runs_estado
    ON public.sync_runs (estado, started_at DESC);

ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sync_runs_read" ON public.sync_runs;
CREATE POLICY "sync_runs_read" ON public.sync_runs
    FOR SELECT TO authenticated USING (true);
