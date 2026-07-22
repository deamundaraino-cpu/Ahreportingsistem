-- migrations/051_sync_jobs.sql
-- Cola de trabajos de sincronización en Postgres.
--
-- Por qué existe:
--   1. Vercel Hobby corta las funciones a 60s y solo admite 2 crons diarios. Un
--      rango de 365 días (Hotmart y GA4 se piden por día) no cabe en una sola
--      invocación: la función moría a mitad y el trabajo se perdía sin rastro.
--   2. El sync manual desde el dashboard y el cron podían correr a la vez sobre
--      el mismo cliente y fecha, duplicando llamadas a las APIs externas.
--
-- La cola resuelve ambos: el trabajo se trocea en unidades reanudables (cursor
-- persistido) y `claim_sync_job` usa FOR UPDATE SKIP LOCKED como mutex, así que
-- dos ejecutores nunca toman el mismo job.
--
-- Ejecutores posibles (comparten esta misma tabla):
--   • `sync-worker/` self-hosted en el VPS (principal, sin límite de tiempo)
--   • POST /api/worker/run-jobs en Vercel (respaldo, tandas de ≤45s)

CREATE TABLE IF NOT EXISTS public.sync_jobs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo          text NOT NULL CHECK (tipo IN (
                      'metricas', 'sheets_leads', 'sheets_conversiones',
                      'meta_leads', 'utm_aggregate', 'cierre_mes'
                  )),
    -- NULL = todos los clientes (el planner lo expande a un job por cliente).
    cliente_id    uuid REFERENCES public.clientes(id) ON DELETE CASCADE,
    fecha_inicio  date,
    fecha_fin     date,
    -- Opciones del job: {"refresh_days": 35, "force": true}
    params        jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Progreso reanudable: {"last_date_done": "2026-07-10"}
    cursor        jsonb NOT NULL DEFAULT '{}'::jsonb,
    estado        text NOT NULL DEFAULT 'pending'
                      CHECK (estado IN ('pending', 'running', 'done', 'error', 'cancelled')),
    -- 1 = manual (el usuario está esperando), 5 = cron nocturno.
    prioridad     int NOT NULL DEFAULT 5,
    intentos      int NOT NULL DEFAULT 0,
    max_intentos  int NOT NULL DEFAULT 3,
    last_error    text,
    -- Lease: si el ejecutor muere, otro puede reclamar el job pasado el timeout.
    locked_at     timestamptz,
    locked_by     text,
    triggered_by  text NOT NULL DEFAULT 'cron',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.sync_jobs IS 'Cola de sincronización. Consumida por sync-worker (VPS) y /api/worker/run-jobs.';
COMMENT ON COLUMN public.sync_jobs.cursor IS 'Progreso persistido: al reanudar se continúa desde aquí, no desde cero.';
COMMENT ON COLUMN public.sync_jobs.locked_at IS 'Inicio del lease. Un job running con lease vencido vuelve a estar disponible.';

-- Orden de consumo de la cola.
CREATE INDEX IF NOT EXISTS idx_sync_jobs_queue
    ON public.sync_jobs (estado, prioridad, created_at);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_cliente
    ON public.sync_jobs (cliente_id, created_at DESC);

-- Evita que el planner encole dos veces el mismo trabajo pendiente.
--
-- NULLS NOT DISTINCT es imprescindible aquí: los jobs globales (sheets, meta_leads,
-- utm_aggregate) llevan cliente_id NULL, y con el comportamiento por defecto
-- Postgres considera cada NULL distinto — dos ejecuciones del planner el mismo día
-- crearían jobs duplicados sin que la restricción se enterara.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sync_jobs_pendiente
    ON public.sync_jobs (tipo, cliente_id, fecha_inicio, fecha_fin)
    NULLS NOT DISTINCT
    WHERE estado IN ('pending', 'running');

CREATE OR REPLACE FUNCTION public.touch_sync_jobs_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_jobs_updated_at ON public.sync_jobs;
CREATE TRIGGER trg_sync_jobs_updated_at
    BEFORE UPDATE ON public.sync_jobs
    FOR EACH ROW EXECUTE FUNCTION public.touch_sync_jobs_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- claim_sync_job: toma UN job de forma atómica.
--
-- SKIP LOCKED es lo que hace de mutex: si dos ejecutores llaman a la vez, el
-- segundo salta la fila bloqueada y coge la siguiente en lugar de esperar o
-- duplicar el trabajo.
--
-- `p_lease_seconds` recupera jobs huérfanos: si el proceso murió (deploy, OOM,
-- corte de los 60s de Vercel), pasado el lease el job vuelve a la cola. El
-- cursor persistido hace que solo se repita la unidad en curso, y los upserts
-- son idempotentes, así que repetirla no duplica datos.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_sync_job(
    p_worker        text,
    p_lease_seconds int DEFAULT 600
)
RETURNS SETOF public.sync_jobs
LANGUAGE sql
AS $$
    UPDATE public.sync_jobs
    SET estado    = 'running',
        locked_at = now(),
        locked_by = p_worker,
        intentos  = intentos + 1
    WHERE id = (
        SELECT id FROM public.sync_jobs
        WHERE estado = 'pending'
           OR (estado = 'running' AND locked_at < now() - make_interval(secs => p_lease_seconds::double precision))
        ORDER BY prioridad ASC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
$$;

-- Renueva el lease de un job largo sin soltarlo (heartbeat del ejecutor).
CREATE OR REPLACE FUNCTION public.heartbeat_sync_job(p_job_id uuid, p_worker text)
RETURNS void
LANGUAGE sql
AS $$
    UPDATE public.sync_jobs
    SET locked_at = now()
    WHERE id = p_job_id AND locked_by = p_worker AND estado = 'running';
$$;

ALTER TABLE public.sync_jobs ENABLE ROW LEVEL SECURITY;

-- Lectura para el panel de admin; la escritura queda al service role.
DROP POLICY IF EXISTS "sync_jobs_read" ON public.sync_jobs;
CREATE POLICY "sync_jobs_read" ON public.sync_jobs
    FOR SELECT TO authenticated USING (true);
