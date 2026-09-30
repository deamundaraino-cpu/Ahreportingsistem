-- 102_sync_runs_ejecutor_default.sql
-- ════════════════════════════════════════════════════════════════
-- `sync_runs.ejecutor` nació con un default que nombraba al hosting anterior.
-- Hoy solo hay dos ejecutores y los dos mandan su valor explícito
-- (`src/lib/sync/runner.ts`): `app` (el drenador de respaldo dentro del
-- contenedor de Next) y `vps` (el `sync-worker` persistente). El default pasa a
-- `app` para que una fila insertada sin el campo no se etiquete con un ejecutor
-- que ya no existe.
--
-- No reescribe filas: las anteriores a esta migración conservan su valor.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE public.sync_runs ALTER COLUMN ejecutor SET DEFAULT 'app';

COMMENT ON COLUMN public.sync_runs.ejecutor IS 'app | vps — de dónde salió la ejecución.';
