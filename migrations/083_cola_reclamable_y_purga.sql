-- ════════════════════════════════════════════════════════════════
-- Migration 083: índice de cola reclamable + purga de sync_jobs
-- ════════════════════════════════════════════════════════════════
-- Sale del diagnóstico de la caída del 2026-09-20/21, en la que la instancia
-- (cómputo Micro, 1 GB) quedó sin poder aceptar conexiones. `claim_sync_job`
-- aparecía en `pg_stat_statements` con 1.600 llamadas y 477 ms de media, cifra
-- inflada por la propia caída pero que destapó dos problemas estructurales.
--
-- ── 1. El OR impide usar el índice para ORDENAR ──────────────────
-- El predicado de `claim_sync_job` es:
--
--     WHERE estado = 'pending'
--        OR (estado = 'running' AND locked_at < now() - lease)
--     ORDER BY prioridad, created_at
--     LIMIT 1
--
-- `idx_sync_jobs_queue (estado, prioridad, created_at)` no sirve aquí: un OR
-- sobre dos valores distintos de la primera columna obliga al planificador a
-- un BitmapOr —que NO conserva el orden del índice— o directamente a un seq
-- scan. En ambos casos hay que ORDENAR todas las filas que casan antes de
-- poder quedarse con una. El LIMIT 1 no ahorra nada.
--
-- El índice parcial de abajo tiene `estado` en el WHERE en vez de en la clave,
-- así que sus entradas ya vienen en orden (prioridad, created_at): el
-- planificador recorre, descarta los `running` con lease vivo sobre la marcha
-- y se detiene en la primera fila válida.
--
-- ── 2. La cola no se purga nunca ─────────────────────────────────
-- `sync_jobs` acumula desde el día uno: 2.037 filas el 2026-09-21, todas menos
-- un puñado en estado `done`. Sin el índice parcial, cada poll del worker
-- —cada 15 segundos, para siempre— las recorre y ordena todas. El índice
-- parcial ya lo resuelve (solo indexa pending/running, normalmente un puñado),
-- pero la tabla merece igualmente una retención: es historial de ejecución, no
-- datos del cliente.
--
-- Idempotente.

-- ── Índice de la cola reclamable ─────────────────────────────────
-- CONCURRENTLY no se usa a propósito: la Management API envía el archivo como
-- una transacción implícita y CONCURRENTLY no puede correr dentro de una. Con
-- una tabla de ~2.000 filas el bloqueo dura milisegundos.
CREATE INDEX IF NOT EXISTS idx_sync_jobs_reclamables
    ON public.sync_jobs (prioridad, created_at)
    WHERE estado IN ('pending', 'running');

COMMENT ON INDEX public.idx_sync_jobs_reclamables IS
    'Cola reclamable por claim_sync_job. estado va en el WHERE, no en la clave: así las entradas conservan el orden (prioridad, created_at) y el LIMIT 1 para en la primera.';

-- `idx_sync_jobs_queue` se conserva: lo usa el panel de admin para listar por
-- estado, que es justo el caso en que `estado` sí debe encabezar la clave.

-- ── Purga del historial de la cola ───────────────────────────────
-- No se invoca aquí: borrar es del usuario, no de la migración. Para aplicarla:
--
--     SELECT public.purgar_sync_jobs(30);
--
-- Devuelve cuántas filas quitó. Solo toca estados terminales — un job pendiente
-- o en curso no se borra por antigüedad ni aunque su lease lleve meses vencido,
-- porque esa fila es trabajo sin hacer, no historial.
CREATE OR REPLACE FUNCTION public.purgar_sync_jobs(p_dias INTEGER DEFAULT 30)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_borradas INTEGER;
BEGIN
    IF p_dias IS NULL OR p_dias < 1 THEN
        RAISE EXCEPTION 'purgar_sync_jobs: p_dias debe ser >= 1 (recibido: %)', COALESCE(p_dias::text, 'NULL');
    END IF;

    DELETE FROM public.sync_jobs
    WHERE estado IN ('done', 'error', 'cancelled')
      AND created_at < now() - make_interval(days => p_dias);

    GET DIAGNOSTICS v_borradas = ROW_COUNT;
    RETURN v_borradas;
END;
$$;

COMMENT ON FUNCTION public.purgar_sync_jobs(INTEGER) IS
    'Borra jobs terminados con más de p_dias días. Nunca toca pending/running: eso es trabajo sin hacer, no historial.';

REVOKE ALL ON FUNCTION public.purgar_sync_jobs(INTEGER) FROM PUBLIC;
